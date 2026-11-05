"""Fetch step: download a model's weights and tokenizer into /out/model. The only step allowed network access.

Only safetensors weights and plain config/tokenizer files are fetched: pickled weights (*.bin, *.pt) and custom
code are refused, so loading the model later never executes code from the download. The requested revision (or the
default branch) is resolved to one commit first and that commit is downloaded, so /out/source.json names exactly
what was fetched.
"""

import json
import os
import sys

from huggingface_hub import HfApi, snapshot_download

ALLOW = ["*.json", "*.safetensors", "*.txt", "*.model", "*.tiktoken", "*.jinja", "LICENSE*", "NOTICE*", "README*"]


def say(kind, **data):
    print("@@valcairn " + json.dumps({"kind": kind, **data}), flush=True)


def main() -> int:
    repo = os.environ["VALCAIRN_MODEL_SOURCE"]
    token = os.environ.get("HF_TOKEN") or None
    commit = HfApi().model_info(repo, revision=os.environ.get("VALCAIRN_MODEL_REVISION") or None, token=token).sha
    path = snapshot_download(repo_id=repo, revision=commit, local_dir="/out/model", allow_patterns=ALLOW, token=token)
    weights = [f for f in os.listdir(path) if f.endswith(".safetensors")]
    if not weights:
        say("log", level="error", message="No safetensors weights in this repository.")
        return 3
    with open("/out/source.json", "w", encoding="utf-8") as f:
        json.dump({"source": repo, "resolvedRevision": commit}, f)
    say("log", level="info", message=f"Fetched {repo} at {commit[:12]} ({len(weights)} weight file(s)).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
