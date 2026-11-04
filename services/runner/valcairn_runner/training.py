"""The train job: frozen inputs from Valcairn, base weights from a cache or the fetch step, LoRA training in the
sandbox with no network, and a report with the held-out loss of the base and the tuned model.

Everything a later export depends on is frozen in a training manifest (out/manifest.json): the base model's source,
revision and every file's SHA-256, the dataset files, the split, the settings and the adapter's files. Valcairn
stores the manifest's SHA-256 with the result, and export refuses anything that no longer matches it."""

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
MAX_TOTAL_BYTES = 20 * 1024**3  # all dataset files of one job together
# Progress lines from the training image; anything else stays on this machine.
PREFIX = "@@valcairn "
EVENT_KINDS = {"log", "metric", "stage", "artifact"}
# Exit codes train.py uses for known problems.
EXIT_CODES = {3: "model_unavailable", 4: "dataset_error", 5: "sandbox_error"}
# Job ids are UUIDs made by Valcairn; anything else never becomes part of a path on this machine.
JOB_ID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
HEX40 = re.compile(r"[0-9a-f]{40}")
SOURCE_RECORD = ".valcairn-source.json"
TRAIN_SETTINGS = {"epochs": 2, "rank": 32}


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


def sha256_json(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def file_hashes(folder: Path, skip=(SOURCE_RECORD,)) -> dict:
    """SHA-256 of every regular file directly in `folder` (not links, not subfolders such as a download cache)."""
    return {p.name: sha256_file(p) for p in sorted(folder.iterdir()) if p.is_file() and not p.is_symlink() and p.name not in skip}


# --- Where things live. Every path under the runner home is checked before anything is written or removed there.

def runner_home(settings) -> Path:
    return Path(settings.home or Path.home() / ".valcairn-runner").resolve()


def confined(home: Path, path: Path) -> Path:
    """`path`, if it stays inside `home` once resolved and no existing part of it below `home` is a link."""
    if home != path and home not in path.parents:
        raise JobFailure("runtime_error", "Refused a path outside the runner home.")
    current = home
    for part in path.relative_to(home).parts:
        current = current / part
        if current.is_symlink():
            raise JobFailure("runtime_error", "Refused a path through a link in the runner home.")
    if home != path.resolve() and home not in path.resolve().parents:
        raise JobFailure("runtime_error", "Refused a path outside the runner home.")
    return path


def attempt_dir(home: Path, job_id, attempt) -> Path:
    """home/jobs/<job id>/attempt-<n>, only for a well-formed job id and attempt number."""
    if not isinstance(job_id, str) or not JOB_ID.fullmatch(job_id) or type(attempt) is not int or not 1 <= attempt <= 10:
        raise JobFailure("runtime_error", "Valcairn sent a malformed job id or attempt; nothing was written.")
    return confined(home, home / "jobs" / job_id / f"attempt-{attempt}")


def remove(home: Path, path: Path) -> None:
    """Remove a folder (or file) under the runner home, after checking where it really is."""
    confined(home, path)
    if path.is_dir():
        shutil.rmtree(path, ignore_errors=True)
    else:
        path.unlink(missing_ok=True)


def check(ctx) -> None:
    """Stop before the next side effect once Valcairn cancelled the job or this runner lost its authority."""
    if ctx.cancelled.is_set():
        raise Cancelled()


def download(url: str, dest: Path, expected_sha: str, opener=None, budget: int = MAX_FILE_BYTES) -> int:
    """Fetch one dataset file through its signed link and refuse it unless its SHA-256 matches the manifest. Partial
    bytes never stay on disk, whatever stops the download. Returns the size."""
    tmp = dest.with_suffix(dest.suffix + ".part")
    h, size, limit = hashlib.sha256(), 0, min(MAX_FILE_BYTES, budget)
    try:
        with (opener or urllib.request.urlopen)(url, timeout=120) as res, tmp.open("wb") as out:
            for chunk in iter(lambda: res.read(1024 * 1024), b""):
                size += len(chunk)
                if size > limit:
                    raise JobFailure("dataset_error", f"{dest.name} is larger than this job's dataset size limit.")
                h.update(chunk)
                out.write(chunk)
        if h.hexdigest() != expected_sha:
            raise JobFailure("dataset_error", f"{dest.name} does not match the checksum in the dataset version.")
        tmp.replace(dest)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    return size


# --- Base model cache: one folder per source and revision, with a record of what was fetched.

def cache_dir(home: Path, source: str, revision: str | None) -> Path:
    key = hashlib.sha256(f"{source}\n{revision or ''}".encode()).hexdigest()[:24]
    return confined(home, home / "models" / f"{safe_name(source)[:60]}-{key}")


def verified_cache(model_dir: Path, source: str, revision: str | None) -> dict | None:
    """The cache record if this folder holds exactly what was fetched for `source` at `revision`: the same source and
    revision, and the same set of files with the same SHA-256 (weights, config and tokenizer alike)."""
    record_path = model_dir / SOURCE_RECORD
    if not record_path.is_file():
        return None
    try:
        record = json.loads(record_path.read_text(encoding="utf-8"))
    except ValueError:
        return None
    if not isinstance(record, dict) or record.get("source") != source or record.get("revision") != revision:
        return None
    return record if file_hashes(model_dir) == record.get("files") else None


def provenance(record: dict) -> dict:
    files = record["files"]
    tokenizer = {k: v for k, v in files.items() if k.startswith("tokenizer") or k in ("vocab.json", "merges.txt", "special_tokens_map.json", "added_tokens.json")}
    out = {"source": record["source"], "weightsSha256": {k: v for k, v in files.items() if k.endswith(".safetensors")}}
    if record.get("resolvedRevision"):
        out["revision"] = record["resolvedRevision"]
    if "config.json" in files:
        out["configSha256"] = files["config.json"]
    if tokenizer:
        out["tokenizerSha256"] = sha256_json(tokenizer)
    return out


def cached_model(ctx, home: Path, source: str, revision: str | None = None) -> tuple[Path, dict]:
    """Base weights for `source` at `revision`, fetched once. A fetch writes into a fresh folder and is moved into
    the cache only after it succeeded and every file's SHA-256 was recorded; every later use checks the record, so a
    half-finished, altered or different model is never trained on. The weights themselves are trusted on first fetch
    from the catalog's source."""
    cache = cache_dir(home, source, revision)
    model_dir = cache / "model"
    record = verified_cache(model_dir, source, revision)
    if record:
        ctx.emit("stage", name="fetch_model", status="skipped")
        return model_dir, record
    if model_dir.exists():
        ctx.log("Cached base model does not match its record; fetching it again.", "warn")
    check(ctx)
    ctx.emit("stage", name="fetch_model", status="started")
    staging = confined(home, cache / f"fetching-{ctx.job['id']}")
    remove(home, staging)
    staging.mkdir(parents=True)
    env = {"VALCAIRN_MODEL_SOURCE": source, **({"VALCAIRN_MODEL_REVISION": revision} if revision else {})}
    fetch = Step(image=ctx.settings.train_image, command=["python", "fetch.py"], network="bridge", output=str(staging),
                 env=env, limits=Limits(cpus=4, memory="4g", seconds=3600, tmpfs_mb=2048))
    try:
        code = ctx.sandbox.run(fetch, lambda line: forward(ctx, line), ctx.cancelled)
        fetched = staging / "model"
        hashes = file_hashes(fetched) if fetched.is_dir() else {}
        if code != 0 or not any(k.endswith(".safetensors") for k in hashes):
            raise JobFailure("model_unavailable", f"The base model could not be fetched from {source}.", retryable=True)
        try:
            said = json.loads((staging / "source.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            said = {}
        resolved = said.get("resolvedRevision") if said.get("source") == source and HEX40.fullmatch(str(said.get("resolvedRevision"))) else None
        record = {"schema": "valcairn.base/1", "source": source, "revision": revision, "resolvedRevision": resolved, "files": hashes}
        (fetched / SOURCE_RECORD).write_text(json.dumps(record, indent=2), encoding="utf-8")
        remove(home, model_dir)
        fetched.replace(model_dir)
    finally:
        remove(home, staging)
    ctx.emit("stage", name="fetch_model", status="finished")
    return model_dir, record


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
    if not isinstance(event, dict):
        return
    kind = event.pop("kind", None)
    if kind in EVENT_KINDS:
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
    home = runner_home(ctx.settings)
    work = attempt_dir(home, ctx.job["id"], ctx.job["attempt"])

    check(ctx)
    try:
        inputs = ctx.api.inputs(ctx.job["id"], ctx.job["leaseToken"])
    except LeaseLost:
        raise Cancelled() from None
    except ApiError as err:
        raise JobFailure("dataset_error" if err.status == 409 else "runtime_error", str(err)) from None

    remove(home, work)
    try:
        return _train(ctx, home, work, inputs)
    except BaseException:
        # A failed attempt keeps nothing: no dataset bytes, no partial adapter.
        remove(home, work)
        raise


def _train(ctx, home: Path, work: Path, inputs: dict) -> dict:
    data, out = work / "data", work / "out"
    data.mkdir(parents=True)
    out.mkdir(parents=True)

    ctx.emit("stage", name="download_data", status="started")
    files = [f for d in inputs["datasets"] for f in d["files"] if str(f["filename"]).lower().endswith(".jsonl")]
    if not files:
        raise JobFailure("dataset_error", "The dataset versions contain no .jsonl files.")
    total, data_files = 0, {}
    for i, f in enumerate(files):
        check(ctx)
        # Stored under a fixed name with a lower-case .jsonl suffix, which train.py and export both read.
        name = f"{i:03d}.jsonl"
        total += download(f["url"], data / name, f["sha256"], budget=MAX_TOTAL_BYTES - total)
        data_files[name] = f["sha256"]
    ctx.emit("metric", name="dataset_files", value=len(files))
    ctx.emit("stage", name="download_data", status="finished")

    source, revision = inputs["baseModel"]["source"], inputs["baseModel"].get("revision")
    model_dir, record = cached_model(ctx, home, source, revision)

    gpus = len(ctx.capabilities["gpus"])
    command = ["python", "train.py"] if gpus == 1 else ["accelerate", "launch", "--multi_gpu", "--num_processes", str(gpus), "train.py"]
    tail: list[str] = []

    def on_line(line: str) -> None:
        tail.append(line)
        del tail[:-40]
        forward(ctx, line)

    check(ctx)
    step = Step(image=ctx.settings.train_image, command=command, gpus=True, output=str(out),
                inputs={str(model_dir): "/in/model", str(data): "/in/data"}, env={"VALCAIRN_TRAIN": json.dumps(TRAIN_SETTINGS)},
                limits=Limits(cpus=8, memory=ctx.settings.train_memory, pids=1024, seconds=ctx.settings.train_seconds, tmpfs_mb=4096, exec_cache_mb=2048, shm="2g"))
    code = ctx.sandbox.run(step, on_line, ctx.cancelled)
    if code != 0:
        text = "\n".join(tail)
        if "OutOfMemoryError" in text or "CUDA out of memory" in text:
            raise JobFailure("out_of_memory", "The GPU ran out of memory.")
        raise JobFailure(EXIT_CODES.get(code, "runtime_error"), f"Training stopped with exit code {code}.")

    report = json.loads((out / "report.json").read_text(encoding="utf-8"))
    adapter_files = file_hashes(out / "adapter")
    digest = adapter_files["adapter_model.safetensors"]
    size = (out / "adapter" / "adapter_model.safetensors").stat().st_size
    ctx.emit("artifact", name="adapter_model.safetensors", sha256=digest, sizeBytes=size)
    split_sha = sha256_file(out / "split.json")
    # Frozen lineage of this adapter; export checks every entry before it uses any of it.
    manifest = {
        "schema": "valcairn.training/1", "trainJobId": ctx.job["id"], "attempt": ctx.job["attempt"],
        "baseModel": {"source": source, "revision": revision, "resolvedRevision": record.get("resolvedRevision"), "files": record["files"]},
        "datasets": [{"projectId": d.get("projectId"), "version": d.get("version"), "files": [{"id": f.get("id"), "sha256": f["sha256"]} for f in d["files"]]} for d in inputs["datasets"]],
        "dataFiles": data_files, "splitSha256": split_sha, "settings": TRAIN_SETTINGS, "image": ctx.settings.train_image,
        "adapter": {"files": adapter_files},
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8")
    return {
        **{k: report[k] for k in ("method", "rank", "alpha", "epochs", "steps", "trainExamples", "heldOutExamples", "skippedLines",
                                  "baseHeldOutLoss", "tunedHeldOutLoss", "trainSeconds", "gpus", "peakGpuMemoryMb")},
        "evaluation": report.get("evaluation"), "samples": report.get("samples", [])[:3],
        "baseModel": {"id": inputs["baseModel"]["id"], **provenance(record)},
        "adapter": {"sha256": digest, "sizeBytes": size, "location": f"jobs/{ctx.job['id']}/attempt-{ctx.job['attempt']}/out/adapter",
                    **({"configSha256": adapter_files["adapter_config.json"]} if "adapter_config.json" in adapter_files else {})},
        "splitSha256": split_sha,
        "trainingManifestSha256": sha256_file(out / "manifest.json"),
        "datasetFiles": len(files),
    }
