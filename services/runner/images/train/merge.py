"""Export step 1: merge a LoRA adapter into its base model and save plain safetensors for conversion.

Inputs (read-only): /in/model (base weights), /in/adapter (the adapter from a training run).
Output: /out/merged (merged weights, config and tokenizer). Runs with no network.
"""

import json
import shutil
import sys
from pathlib import Path

TOKENIZER_FILES = {"vocab.json", "merges.txt", "special_tokens_map.json", "added_tokens.json"}


def say(kind, **data):
    print("@@valcairn " + json.dumps({"kind": kind, **data}), flush=True)


def main() -> int:
    import torch
    from peft import PeftModel
    from transformers import AutoModelForCausalLM

    say("stage", name="merge", status="started")
    base = AutoModelForCausalLM.from_pretrained("/in/model", dtype=torch.bfloat16, trust_remote_code=False)
    merged = PeftModel.from_pretrained(base, "/in/adapter").merge_and_unload()
    merged.save_pretrained("/out/merged", safe_serialization=True)
    # A LoRA merge leaves the tokenizer unchanged, so the base model's own files are copied as they are: re-saving
    # them through a newer transformers changes their format for GGUF converters.
    for path in Path("/in/model").iterdir():
        if path.name.startswith("tokenizer") or path.name in TOKENIZER_FILES or path.suffix == ".jinja":
            shutil.copy(path, Path("/out/merged") / path.name)
    say("stage", name="merge", status="finished")
    return 0


if __name__ == "__main__":
    sys.exit(main())
