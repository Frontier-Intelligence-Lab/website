"""Training step: LoRA supervised fine-tuning on the job's frozen dataset files, with a held-out comparison.

Inputs (read-only): /in/model (weights from the fetch step), /in/data (*.jsonl files from the dataset versions).
Output: /out/adapter (LoRA adapter, safetensors), /out/report.json, /out/split.json.
Progress lines start with "@@valcairn " followed by one JSON event; the runner forwards them to Valcairn.

Examples are JSON lines with either {"messages": [{"role": ..., "content": ...}, ...]} or {"prompt": ..., "completion": ...}.
About 10% of examples (chosen by a hash of their content, so the split is reproducible) are held out and never
trained on. Held-out loss is measured on the unchanged base model first, then on the tuned model.
"""

import hashlib
import json
import math
import os
import re
import sys
import time
from pathlib import Path


def say(kind, **data):
    # Under `accelerate launch` on several GPUs every process runs this script; only the first one reports.
    if os.environ.get("RANK", "0") != "0":
        return
    print("@@valcairn " + json.dumps({"kind": kind, **data}), flush=True)


def normalise(row):
    if isinstance(row.get("messages"), list) and all(isinstance(m, dict) and m.get("role") in ("system", "user", "assistant") and isinstance(m.get("content"), str) for m in row["messages"]):
        roles = [m["role"] for m in row["messages"]]
        if "assistant" in roles and "user" in roles:
            return {"messages": row["messages"]}
    if isinstance(row.get("prompt"), str) and isinstance(row.get("completion"), str):
        return {"messages": [{"role": "user", "content": row["prompt"]}, {"role": "assistant", "content": row["completion"]}]}
    return None


def load_examples(folder):
    examples, skipped = [], 0
    for path in sorted(Path(folder).rglob("*.jsonl")):
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            if not line.strip():
                continue
            try:
                ex = normalise(json.loads(line))
            except ValueError:
                ex = None
            if ex is None:
                skipped += 1
            else:
                examples.append(ex)
    return examples, skipped


def digest(ex):
    return hashlib.sha256(json.dumps(ex, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def split(examples, holdout_every=10):
    train, held = [], []
    for ex in examples:
        (held if int(digest(ex)[:8], 16) % holdout_every == 0 else train).append(ex)
    if not held and len(train) >= 5:  # tiny sets: still keep one example out
        held.append(train.pop())
    return train, held


def tokens(text):
    return re.findall(r"\w+", text.lower())


def token_f1(prediction, reference):
    """SQuAD-style token overlap between a generated answer and the reference answer."""
    p, r = tokens(prediction), tokens(reference)
    if not p or not r:
        return float(p == r)
    common = sum(min(p.count(t), r.count(t)) for t in set(p))
    if not common:
        return 0.0
    precision, recall = common / len(p), common / len(r)
    return 2 * precision * recall / (precision + recall)


def generate(model, tokenizer, rows, max_new_tokens=160):
    """Greedy answers to each held-out example's last user turn, without the reference answer."""
    import torch
    answers = []
    model.eval()
    for row in rows:
        turns = row["messages"][: max(i for i, m in enumerate(row["messages"]) if m["role"] == "assistant")]
        inputs = tokenizer.apply_chat_template(turns, add_generation_prompt=True, return_tensors="pt", return_dict=True, enable_thinking=False).to(model.device)
        with torch.no_grad():
            out = model.generate(**inputs, max_new_tokens=max_new_tokens, do_sample=False, pad_token_id=tokenizer.pad_token_id or tokenizer.eos_token_id)
        answers.append(tokenizer.decode(out[0][inputs["input_ids"].shape[-1]:], skip_special_tokens=True).strip())
    return answers


def scores(answers, rows):
    refs = [next(m["content"] for m in reversed(r["messages"]) if m["role"] == "assistant") for r in rows]
    f1 = [token_f1(a, ref) for a, ref in zip(answers, refs)]
    exact = [a.strip() == ref.strip() for a, ref in zip(answers, refs)]
    return {"f1": sum(f1) / len(f1), "exact": sum(exact) / len(exact), "n": len(rows)}


def main() -> int:
    settings = json.loads(os.environ.get("VALCAIRN_TRAIN", "{}"))
    examples, skipped = load_examples("/in/data")
    say("metric", name="examples", value=len(examples))
    if skipped:
        say("log", level="warn", message=f"Skipped {skipped} line(s) that are not chat or prompt/completion examples.")
    train_rows, held_rows = split(examples)
    if len(train_rows) < 4 or not held_rows:
        say("log", level="error", message="Not enough usable examples: need at least 5 chat or prompt/completion lines.")
        return 4
    if os.environ.get("RANK", "0") == "0":
        Path("/out/split.json").write_text(json.dumps({"train": [digest(e) for e in train_rows], "heldOut": [digest(e) for e in held_rows]}))
    say("metric", name="train_examples", value=len(train_rows))
    say("metric", name="held_out_examples", value=len(held_rows))

    import torch
    from datasets import Dataset
    from peft import LoraConfig
    from transformers import AutoModelForCausalLM, AutoTokenizer, TrainerCallback
    from trl import SFTConfig, SFTTrainer

    if not torch.cuda.is_available():
        say("log", level="error", message="No GPU is visible inside the sandbox.")
        return 5
    say("stage", name="load_model", status="started")
    tokenizer = AutoTokenizer.from_pretrained("/in/model", trust_remote_code=False)
    model = AutoModelForCausalLM.from_pretrained("/in/model", dtype=torch.bfloat16, trust_remote_code=False)
    say("stage", name="load_model", status="finished")

    class Progress(TrainerCallback):
        def on_log(self, args, state, control, logs=None, **kwargs):
            for key in ("loss", "eval_loss", "learning_rate", "grad_norm", "mean_token_accuracy"):
                try:
                    value = float((logs or {})[key])
                except (KeyError, TypeError, ValueError):
                    continue
                if math.isfinite(value):
                    say("metric", name="train_loss" if key == "loss" else key, value=value, step=int(state.global_step))

    config = SFTConfig(
        output_dir="/tmp/run", num_train_epochs=float(settings.get("epochs", 2)), per_device_train_batch_size=int(settings.get("batchSize", 4)),
        gradient_accumulation_steps=int(settings.get("gradAccum", 2)), learning_rate=float(settings.get("learningRate", 2e-4)),
        logging_steps=5, eval_strategy="no", save_strategy="no", report_to=[], bf16=True, max_length=int(settings.get("maxLength", 1024)),
        seed=int(settings.get("seed", 7)), gradient_checkpointing=True, disable_tqdm=True,
    )
    lora = LoraConfig(r=int(settings.get("rank", 32)), lora_alpha=int(settings.get("alpha", 64)), lora_dropout=0.05, target_modules="all-linear", task_type="CAUSAL_LM")
    trainer = SFTTrainer(model=model, args=config, train_dataset=Dataset.from_list(train_rows), eval_dataset=Dataset.from_list(held_rows),
                         processing_class=tokenizer, peft_config=lora, callbacks=[Progress()])

    say("stage", name="baseline_eval", status="started")
    with trainer.model.disable_adapter():
        base_loss = trainer.evaluate()["eval_loss"]
    say("metric", name="base_held_out_loss", value=float(base_loss))
    say("stage", name="baseline_eval", status="finished")

    say("stage", name="train", status="started")
    started = time.time()
    result = trainer.train()
    seconds = time.time() - started
    say("stage", name="train", status="finished")

    say("stage", name="tuned_eval", status="started")
    tuned_loss = trainer.evaluate()["eval_loss"]
    say("metric", name="tuned_held_out_loss", value=float(tuned_loss))
    say("stage", name="tuned_eval", status="finished")

    # Answers on the same held-out examples, base (adapter off) and tuned, scored against the reference answers.
    say("stage", name="answer_eval", status="started")
    with trainer.model.disable_adapter():
        base_answers = generate(trainer.model, tokenizer, held_rows)
    tuned_answers = generate(trainer.model, tokenizer, held_rows)
    evaluation = {"base": scores(base_answers, held_rows), "tuned": scores(tuned_answers, held_rows), "metric": "token F1 and exact match against the reference answer"}
    say("metric", name="base_answer_f1", value=evaluation["base"]["f1"])
    say("metric", name="tuned_answer_f1", value=evaluation["tuned"]["f1"])
    say("stage", name="answer_eval", status="finished")
    samples = [{"prompt": next(m["content"] for m in reversed(r["messages"]) if m["role"] == "user")[:300], "base": b[:400], "tuned": t[:400]}
               for r, b, t in list(zip(held_rows, base_answers, tuned_answers))[:3]]

    peak = torch.tensor(max(torch.cuda.max_memory_allocated(i) for i in range(torch.cuda.device_count())), device=trainer.model.device)
    if torch.distributed.is_available() and torch.distributed.is_initialized():
        torch.distributed.all_reduce(peak, op=torch.distributed.ReduceOp.MAX)
    if os.environ.get("RANK", "0") != "0":
        return 0
    trainer.model.save_pretrained("/out/adapter", safe_serialization=True)
    tokenizer.save_pretrained("/out/adapter")
    report = {
        "method": "sft-lora", "rank": lora.r, "alpha": lora.lora_alpha, "epochs": config.num_train_epochs, "steps": int(result.global_step),
        "trainExamples": len(train_rows), "heldOutExamples": len(held_rows), "skippedLines": skipped,
        "baseHeldOutLoss": float(base_loss), "tunedHeldOutLoss": float(tuned_loss), "trainSeconds": round(seconds, 1),
        "gpus": [torch.cuda.get_device_name(0)] * int(os.environ.get("WORLD_SIZE", torch.cuda.device_count())),
        "peakGpuMemoryMb": int(peak.item() / 2**20),  # the highest of any GPU used
        "evaluation": evaluation, "samples": samples,
    }
    Path("/out/report.json").write_text(json.dumps(report, indent=2))
    say("log", level="info", message=f"Held-out loss {base_loss:.4f} on the base model, {tuned_loss:.4f} after training.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
