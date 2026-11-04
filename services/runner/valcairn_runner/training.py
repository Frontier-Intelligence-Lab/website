"""The train job: frozen inputs from Valcairn, base weights from a cache or the fetch step, LoRA training in the
sandbox with no network, and a report with the held-out loss of the base and the tuned model."""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import urllib.request
from pathlib import Path

from .api import ApiError, LeaseLost
from .sandbox import Cancelled, Limits, Step

MAX_FILE_BYTES = 2 * 1024**3
# Progress lines from the training image; anything else stays on this machine.
PREFIX = "@@valcairn "
EVENT_KINDS = {"log", "metric", "stage", "artifact"}
# Exit codes train.py uses for known problems.
EXIT_CODES = {3: "model_unavailable", 4: "dataset_error", 5: "sandbox_error"}


class JobFailure(Exception):
    def __init__(self, category: str, message: str = "", retryable: bool = False):
        super().__init__(message or category)
        self.category = category
        self.retryable = retryable


def safe_name(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip("-")[:120] or "model"


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def download(url: str, dest: Path, expected_sha: str, opener=None) -> None:
    """Fetch one dataset file through its signed link and refuse it unless its SHA-256 matches the manifest."""
    tmp = dest.with_suffix(dest.suffix + ".part")
    h, size = hashlib.sha256(), 0
    with (opener or urllib.request.urlopen)(url, timeout=120) as res, tmp.open("wb") as out:
        for chunk in iter(lambda: res.read(1024 * 1024), b""):
            size += len(chunk)
            if size > MAX_FILE_BYTES:
                raise JobFailure("dataset_error", f"{dest.name} is larger than {MAX_FILE_BYTES} bytes.")
            h.update(chunk)
            out.write(chunk)
    if h.hexdigest() != expected_sha:
        tmp.unlink(missing_ok=True)
        raise JobFailure("dataset_error", f"{dest.name} does not match the checksum in the dataset version.")
    tmp.replace(dest)


WEIGHTS = ".valcairn-weights.json"


def normalise(row) -> dict | None:
    """The example rule train.py uses (kept identical, so hashes and held-out lookups agree): a chat with a user turn
    and an assistant answer, or a prompt/completion pair."""
    if not isinstance(row, dict):
        return None
    messages = row.get("messages")
    if isinstance(messages, list) and all(isinstance(m, dict) and m.get("role") in ("system", "user", "assistant") and isinstance(m.get("content"), str) for m in messages):
        roles = [m["role"] for m in messages]
        if "assistant" in roles and "user" in roles:
            return {"messages": messages}
    if isinstance(row.get("prompt"), str) and isinstance(row.get("completion"), str):
        return {"messages": [{"role": "user", "content": row["prompt"]}, {"role": "assistant", "content": row["completion"]}]}
    return None


def weight_hashes(folder: Path) -> dict:
    return {p.name: sha256_file(p) for p in sorted(folder.glob("*.safetensors"))}


def cached_model(ctx, home: Path, source: str) -> tuple[Path, dict]:
    """Base weights for `source`, fetched once. A fetch writes into a fresh folder and is moved into the cache only
    after it succeeded and each weight file's SHA-256 was recorded; every later use checks those hashes, so a
    half-finished or altered cache is never trained on. The hashes go to Valcairn with the result. The weights
    themselves are trusted on first fetch from the catalog's source."""
    cache = home / "models" / safe_name(source)
    model_dir, record = cache / "model", cache / "model" / WEIGHTS
    if record.exists():
        expected = json.loads(record.read_text(encoding="utf-8"))
        if weight_hashes(model_dir) == expected:
            ctx.emit("stage", name="fetch_model", status="skipped")
            return model_dir, expected
        ctx.log("Cached base weights no longer match their recorded hashes; fetching them again.", "warn")
    ctx.emit("stage", name="fetch_model", status="started")
    staging = cache / f"fetching-{ctx.job['id']}"
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True)
    fetch = Step(image=ctx.settings.train_image, command=["python", "fetch.py"], network="bridge", output=str(staging),
                 env={"VALCAIRN_MODEL_SOURCE": source}, limits=Limits(cpus=4, memory="4g", seconds=3600, tmpfs_mb=2048))
    try:
        code = ctx.sandbox.run(fetch, lambda line: forward(ctx, line), ctx.cancelled)
        hashes = weight_hashes(staging / "model") if (staging / "model").is_dir() else {}
        if code != 0 or not hashes:
            raise JobFailure("model_unavailable", f"The base model could not be fetched from {source}.", retryable=True)
        (staging / "model" / WEIGHTS).write_text(json.dumps(hashes, indent=2), encoding="utf-8")
        shutil.rmtree(model_dir, ignore_errors=True)
        (staging / "model").replace(model_dir)
    finally:
        shutil.rmtree(staging, ignore_errors=True)
    ctx.emit("stage", name="fetch_model", status="finished")
    return model_dir, hashes


def forward(ctx, line: str) -> None:
    """Turn a progress line from the image into a Valcairn event; other output is not sent."""
    # Progress bars redraw with carriage returns, so a progress line can arrive glued to other output.
    at = line.rfind(PREFIX)
    if at < 0:
        return
    try:
        event = json.loads(line[at + len(PREFIX):])
    except ValueError:
        return
    kind = event.pop("kind", None)
    if kind in EVENT_KINDS and isinstance(event, dict):
        ctx.emit(kind, **event)


def train(ctx) -> dict:
    spec = ctx.spec
    steps = spec["plan"]["steps"]
    if "sft" not in steps:
        raise JobFailure("unsupported", "Only fine-tuning (sft) runs on a runner today.")
    for other in (s for s in steps if s != "sft"):
        ctx.emit("stage", name=other, status="skipped")
    if not ctx.capabilities.get("gpus"):
        raise JobFailure("sandbox_unavailable", "Training needs a GPU on this runner.")

    try:
        inputs = ctx.api.inputs(ctx.job["id"], ctx.job["leaseToken"])
    except LeaseLost:
        raise Cancelled() from None
    except ApiError as err:
        raise JobFailure("dataset_error" if err.status == 409 else "runtime_error", str(err)) from None

    home = Path(ctx.settings.home or Path.home() / ".valcairn-runner")
    work = home / "jobs" / ctx.job["id"] / f"attempt-{ctx.job['attempt']}"
    data, out = work / "data", work / "out"
    shutil.rmtree(work, ignore_errors=True)
    data.mkdir(parents=True)
    out.mkdir(parents=True)

    ctx.emit("stage", name="download_data", status="started")
    files = [f for d in inputs["datasets"] for f in d["files"] if str(f["filename"]).lower().endswith(".jsonl")]
    if not files:
        raise JobFailure("dataset_error", "The dataset versions contain no .jsonl files.")
    for i, f in enumerate(files):
        if ctx.cancelled.is_set():
            raise Cancelled()
        download(f["url"], data / f"{i:03d}-{safe_name(f['filename'])}", f["sha256"])
    ctx.emit("metric", name="dataset_files", value=len(files))
    ctx.emit("stage", name="download_data", status="finished")

    source = inputs["baseModel"]["source"]
    model_dir, weights = cached_model(ctx, home, source)

    gpus = len(ctx.capabilities["gpus"])
    command = ["python", "train.py"] if gpus == 1 else ["accelerate", "launch", "--multi_gpu", "--num_processes", str(gpus), "train.py"]
    tail: list[str] = []

    def on_line(line: str) -> None:
        tail.append(line)
        del tail[:-40]
        forward(ctx, line)

    step = Step(image=ctx.settings.train_image, command=command, gpus=True, output=str(out),
                inputs={str(model_dir): "/in/model", str(data): "/in/data"}, env={"VALCAIRN_TRAIN": json.dumps({"epochs": 2, "rank": 32})},
                limits=Limits(cpus=8, memory=ctx.settings.train_memory, pids=1024, seconds=ctx.settings.train_seconds, tmpfs_mb=4096, exec_cache_mb=2048, shm="2g"))
    code = ctx.sandbox.run(step, on_line, ctx.cancelled)
    if code != 0:
        text = "\n".join(tail)
        if "OutOfMemoryError" in text or "CUDA out of memory" in text:
            raise JobFailure("out_of_memory", "The GPU ran out of memory.")
        raise JobFailure(EXIT_CODES.get(code, "runtime_error"), f"Training stopped with exit code {code}.")

    report = json.loads((out / "report.json").read_text(encoding="utf-8"))
    adapter = out / "adapter" / "adapter_model.safetensors"
    digest, size = sha256_file(adapter), adapter.stat().st_size
    ctx.emit("artifact", name="adapter_model.safetensors", sha256=digest, sizeBytes=size)
    return {
        **{k: report[k] for k in ("method", "rank", "alpha", "epochs", "steps", "trainExamples", "heldOutExamples", "skippedLines",
                                  "baseHeldOutLoss", "tunedHeldOutLoss", "trainSeconds", "gpus", "peakGpuMemoryMb")},
        "evaluation": report.get("evaluation"), "samples": report.get("samples", [])[:3],
        "baseModel": {"id": inputs["baseModel"]["id"], "source": source, "weightsSha256": weights},
        "adapter": {"sha256": digest, "sizeBytes": size, "location": f"jobs/{ctx.job['id']}/attempt-{ctx.job['attempt']}/out/adapter"},
        "splitSha256": sha256_file(out / "split.json"),
        "datasetFiles": len(files),
    }
