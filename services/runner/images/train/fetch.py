"""Fetch step: download a model's weights and tokenizer into /out/model. The only step allowed network access.

Only safetensors weights and plain config/tokenizer files are fetched: pickled weights (*.bin, *.pt) and custom
code are refused, so loading the model later never executes code from the download.
"""

import json
import os
import sys

from huggingface_hub import snapshot_download

ALLOW = ["*.json", "*.safetensors", "*.txt", "*.model", "*.tiktoken", "*.jinja", "LICENSE*", "NOTICE*", "README*"]


def main() -> int:
    repo = os.environ["VALCAIRN_MODEL_SOURCE"]
    revision = os.environ.get("VALCAIRN_MODEL_REVISION") or None
    path = snapshot_download(repo_id=repo, revision=revision, local_dir="/out/model", allow_patterns=ALLOW, token=os.environ.get("HF_TOKEN") or None)
    weights = [f for f in os.listdir(path) if f.endswith(".safetensors")]
    if not weights:
        print("@@valcairn " + json.dumps({"kind": "log", "level": "error", "message": "No safetensors weights in this repository."}), flush=True)
        return 3
    print("@@valcairn " + json.dumps({"kind": "log", "level": "info", "message": f"Fetched {repo} ({len(weights)} weight file(s))."}), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
