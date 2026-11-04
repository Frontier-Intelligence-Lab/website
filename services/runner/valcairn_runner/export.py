"""The export job: merge a finished training run's adapter, convert the base and the tuned model to GGUF with the
same quantization, load both into the Ollama on this machine, load-test them on held-out prompts, and write a
manifest with checksums and a model card. Every container step runs with no network."""

from __future__ import annotations

import json
import shutil
import subprocess
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from .sandbox import Limits, Step
from .training import JobFailure, cached_model, forward, safe_name, sha256_file

QUANT = "q8_0"
MAX_PROMPTS = 3


def ollama_chat(host: str, model: str, messages: list[dict], opener=None) -> dict:
    body = json.dumps({"model": model, "messages": messages, "stream": False, "think": False,
                       "options": {"temperature": 0, "seed": 7, "num_predict": 160}}).encode()
    req = urllib.request.Request(f"{host}/api/chat", data=body, headers={"content-type": "application/json"})
    with (opener or urllib.request.urlopen)(req, timeout=300) as res:
        return json.loads(res.read())


def load_test(host: str, model: str, conversations: list[list[dict]], opener=None) -> dict:
    """The same held-out conversations, greedy decoding; speed from Ollama's own counters (nanoseconds)."""
    answers, tokens, eval_ns = [], 0, 0
    for turns in conversations:
        r = ollama_chat(host, model, turns, opener)
        answers.append(r.get("message", {}).get("content", "").strip()[:600])
        tokens += r.get("eval_count", 0)
        eval_ns += r.get("eval_duration", 0)
    return {"model": model, "tokensPerSec": round(tokens / (eval_ns / 1e9), 1) if eval_ns else None, "answers": answers}


def ollama_create(name: str, folder: Path, run=subprocess.run) -> None:
    """Native Ollama: `ollama create` reads the Modelfile next to the GGUF and stores the model locally."""
    out = run(["ollama", "create", name, "-f", str(folder / "Modelfile")], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=1800, check=False)
    if out.returncode != 0:
        raise JobFailure("runtime_error", "Ollama could not create the model.")


def held_out(train_dir: Path) -> tuple[list[list[dict]], str | None]:
    """Held-out conversations (never trained on) without their reference answers, found through the training run's
    own split file (the same example hashing as train.py), and the system prompt if every example used the same one."""
    import hashlib
    split = json.loads((train_dir / "out" / "split.json").read_text(encoding="utf-8"))
    held = set(split["heldOut"])
    conversations, systems = [], set()
    for path in sorted((train_dir / "data").glob("*.jsonl")):
        for line in path.read_text(encoding="utf-8").splitlines():
            try:
                row = json.loads(line)
            except ValueError:
                continue
            ex = {"messages": row["messages"]} if "messages" in row else {"messages": [{"role": "user", "content": row.get("prompt", "")}, {"role": "assistant", "content": row.get("completion", "")}]}
            messages = ex["messages"]
            systems.add(messages[0]["content"] if messages and messages[0].get("role") == "system" else None)
            last = max((i for i, m in enumerate(messages) if m.get("role") == "assistant"), default=None)
            if last and len(conversations) < MAX_PROMPTS and hashlib.sha256(json.dumps(ex, sort_keys=True, ensure_ascii=False).encode()).hexdigest() in held:
                conversations.append(messages[:last])
    return conversations, (next(iter(systems)) if len(systems) == 1 else None)


def convert(ctx, src: Path, out: Path, name: str) -> Path:
    out.mkdir(parents=True, exist_ok=True)
    step = Step(image=ctx.settings.convert_image, command=["python3", "/app/convert_hf_to_gguf.py", "/in/hf", "--outtype", QUANT, "--outfile", f"/out/{name}"],
                inputs={str(src): "/in/hf"}, output=str(out), env={"HOME": "/tmp", "HF_HOME": "/tmp/hf"},
                # The llama.cpp image's entrypoint is its own tool launcher; the converter is run directly instead.
                entrypoint="", limits=Limits(cpus=8, memory="16g", seconds=3600, tmpfs_mb=1024))
    code = ctx.sandbox.run(step, lambda line: forward(ctx, line), ctx.cancelled)
    gguf = out / name
    if code != 0 or not gguf.exists():
        raise JobFailure("runtime_error", f"GGUF conversion failed with exit code {code}.")
    return gguf


def modelfile(folder: Path, gguf: Path, system: str | None = None) -> None:
    text = f"FROM ./{gguf.name}\nPARAMETER temperature 0.2\n"
    if system:
        # The system prompt every training example used, so plain chat with the model behaves as it was trained.
        text += 'SYSTEM """' + system.replace('"""', "'''") + '"""\n'
    (folder / "Modelfile").write_text(text, encoding="utf-8")


def export(ctx) -> dict:
    source = ctx.spec.get("source") or {}
    home = Path(ctx.settings.home or Path.home() / ".valcairn-runner")
    rel = source.get("adapterLocation") or ""
    adapter_dir = (home / rel).resolve()
    if not rel or home.resolve() not in adapter_dir.parents or not (adapter_dir / "adapter_model.safetensors").exists():
        raise JobFailure("model_unavailable", "The training run's adapter is not on this runner.")
    if sha256_file(adapter_dir / "adapter_model.safetensors") != source.get("adapterSha256"):
        raise JobFailure("model_unavailable", "The adapter on this runner does not match the one Valcairn recorded.")
    base_source = ctx.spec["baseModel"]["source"]
    model_dir, _ = cached_model(ctx, home, base_source)

    work = home / "jobs" / ctx.job["id"] / f"attempt-{ctx.job['attempt']}"
    shutil.rmtree(work, ignore_errors=True)
    (work / "merged").mkdir(parents=True)
    merge = Step(image=ctx.settings.train_image, command=["python", "merge.py"], gpus=bool(ctx.capabilities.get("gpus")),
                 inputs={str(model_dir): "/in/model", str(adapter_dir): "/in/adapter"}, output=str(work / "merged"),
                 limits=Limits(cpus=8, memory=ctx.settings.train_memory, seconds=3600, tmpfs_mb=2048, exec_cache_mb=1024, shm="2g"))
    if ctx.sandbox.run(merge, lambda line: forward(ctx, line), ctx.cancelled) != 0:
        raise JobFailure("runtime_error", "Merging the adapter failed.")

    ctx.emit("stage", name="convert", status="started")
    tuned_dir = work / "gguf"
    tuned = convert(ctx, work / "merged" / "merged", tuned_dir, f"model-{QUANT}.gguf")
    # The base model, converted the same way once per runner, so the comparison is like for like.
    base_dir = home / "models" / safe_name(base_source) / "gguf"
    base = base_dir / f"base-{QUANT}.gguf"
    if not base.exists():
        convert(ctx, model_dir, base_dir, base.name)
    ctx.emit("stage", name="convert", status="finished")

    short = ctx.job["id"].split("-")[0]
    tuned_name, base_name = f"valcairn-{short}", f"valcairn-base-{safe_name(base_source).lower()}"
    ctx.emit("stage", name="ollama_create", status="started")
    conversations, system = held_out(adapter_dir.parent.parent)
    modelfile(tuned_dir, tuned, system)
    ollama_create(tuned_name, tuned_dir)
    modelfile(base_dir, base)
    ollama_create(base_name, base_dir)
    ctx.emit("stage", name="ollama_create", status="finished")

    # Both models answer the same held-out conversations, system prompt included, as they would in use.
    ctx.emit("stage", name="load_test", status="started")
    host = ctx.settings.ollama_host
    started = time.time()
    tuned_test = load_test(host, tuned_name, conversations)
    base_test = load_test(host, base_name, conversations)
    ctx.emit("metric", name="tuned_tokens_per_sec", value=tuned_test["tokensPerSec"] or 0)
    ctx.emit("metric", name="base_tokens_per_sec", value=base_test["tokensPerSec"] or 0)
    ctx.emit("stage", name="load_test", status="finished")

    gguf_sha = sha256_file(tuned)
    ctx.emit("artifact", name=tuned.name, sha256=gguf_sha, sizeBytes=tuned.stat().st_size)
    manifest = {
        "schema": "valcairn.export/1", "createdAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "trainJobId": source["trainJobId"], "baseModel": {"id": ctx.spec["baseModel"]["id"], "source": base_source, "license": ctx.spec["baseModel"].get("license")},
        "adapter": {"sha256": source["adapterSha256"]}, "gguf": {"file": tuned.name, "sha256": gguf_sha, "sizeBytes": tuned.stat().st_size, "quantization": QUANT},
        "ollama": {"model": tuned_name, "baseModel": base_name},
    }
    (tuned_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    (tuned_dir / "MODEL_CARD.md").write_text(
        f"# {tuned_name}\n\nFine-tuned with LoRA by Valcairn from `{base_source}` ({manifest['baseModel']['license']}).\n\n"
        f"- Training run: `{source['trainJobId']}`\n- Adapter SHA-256: `{source['adapterSha256']}`\n- GGUF ({QUANT}) SHA-256: `{gguf_sha}`\n\n"
        "Keep the base model's license with any copy of these weights. Evaluate on your own held-out cases before relying on it.\n", encoding="utf-8")
    license_file = model_dir / "LICENSE"
    if license_file.exists():
        shutil.copy(license_file, tuned_dir / "LICENSE")
    return {
        "ollamaModel": tuned_name, "gguf": manifest["gguf"], "manifestSha256": sha256_file(tuned_dir / "manifest.json"),
        "loadTest": {"conversations": len(conversations), "seconds": round(time.time() - started, 1),
                     "tuned": {"model": tuned_name, "tokensPerSec": tuned_test["tokensPerSec"]}, "base": {"model": base_name, "tokensPerSec": base_test["tokensPerSec"]}},
        "samples": [{"prompt": turns[-1]["content"][:300], "base": b[:400], "tuned": t[:400]} for turns, b, t in zip(conversations, base_test["answers"], tuned_test["answers"])],
        "location": f"jobs/{ctx.job['id']}/attempt-{ctx.job['attempt']}/gguf",
    }
