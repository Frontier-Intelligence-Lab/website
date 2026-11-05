"""The export job: check a finished training run's frozen lineage, merge its adapter, convert the base and the tuned
model to GGUF with the same quantization, load both into the Ollama on this machine, load-test them on held-out
prompts, and only then publish the tuned model under its final name with a manifest and a model card.

- Lineage: the training manifest Valcairn recorded (its SHA-256 is frozen into this job) must match the adapter, the
  split, the dataset files and the cached base model byte for byte; anything else stops the export.
- Ollama: one configured target, which must be this machine (loopback). The CLI gets it explicitly and the HTTP calls
  use it, so weights never go to another daemon through an inherited OLLAMA_HOST.
- Names: models are created under a provisional name for this job and attempt and copied to the final name only after
  the load test passed. Nothing is ever created over an existing name, so a retry cannot replace an earlier result
  or a model someone made by hand. Ollama has no create-only-if-absent, so this is a check followed by a create: a
  model made by hand under exactly this job's provisional name in between would be replaced. The names carry the
  job's UUID and attempt, so that takes a deliberate collision. A cancel known before the copy means no publication;
  a cancel seen after the copy was dispatched ends the attempt and removes the copied model best effort, because
  the copy itself cannot be undone atomically.
- Cancellation and lost authority are checked before every conversion, model creation and load test, and again while
  Ollama is answering a load-test request, whichever packet of the reply is awaited: the wait ends, the connection
  is shut down and the answer is not used. Ollama stops a generation whose client is gone; that is its behaviour,
  not something this runner confirms.
Every container step runs with no network."""

from __future__ import annotations

import http.client
import json
import os
import re
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from .api import authenticated_opener
from .examples import digest, is_data_file, normalise, prompt_turns
from .sandbox import Cancelled, Limits, Step
from .training import (JOB_ID, JobFailure, attempt_dir, cache_dir, check, confined, file_hashes, forward, remove,
                       runner_home, sha256_file, sha256_json, verified_cache)
from .transport import exchange, shutdown

QUANT = "q8_0"
MAX_PROMPTS = 3
CREATE_SECONDS = 1800
CHAT_SECONDS = 300
STOP_SECONDS = 10  # how long a killed `ollama create` client is waited for
MAX_COUNTER = 2**53  # Ollama's token and nanosecond counters are small non-negative integers
MAX_REPLY_BYTES = 1 << 20  # a non-streaming chat reply of 160 tokens is a few KB; more than this is not one


# --- Ollama on this machine

def local_ollama(host: str) -> str:
    """The configured Ollama address, if it is plain http on this machine; refused otherwise."""
    try:
        u = urllib.parse.urlsplit(host)
        port = u.port or 11434
    except ValueError:
        port, u = None, None
    if not u or u.scheme != "http" or u.hostname not in ("127.0.0.1", "localhost", "::1") or u.username or u.password \
            or u.path not in ("", "/") or u.query or u.fragment or not port:
        raise JobFailure("sandbox_unavailable", "OLLAMA_HOST_URL must be http on this machine (127.0.0.1, localhost or ::1).")
    return f"http://{'[::1]' if u.hostname == '::1' else u.hostname}:{port}"


def _http(host: str, path: str, body: dict, method="POST", opener=None, timeout=300):
    req = urllib.request.Request(f"{host}{path}", data=json.dumps(body).encode(), method=method, headers={"content-type": "application/json"})
    with (opener or authenticated_opener())(req, timeout=timeout) as res:
        raw = res.read()
    return json.loads(raw) if raw else {}


def ollama_has(host: str, name: str, opener=None) -> bool:
    try:
        _http(host, "/api/show", {"model": name}, opener=opener, timeout=30)
        return True
    except urllib.error.HTTPError as err:
        if err.code == 404:
            return False
        raise JobFailure("runtime_error", "Ollama on this machine could not be asked about a model.") from None
    except (OSError, ValueError):
        raise JobFailure("runtime_error", "Ollama on this machine did not answer.") from None


def ollama_copy(host: str, source: str, destination: str, opener=None) -> None:
    try:
        _http(host, "/api/copy", {"source": source, "destination": destination}, opener=opener, timeout=120)
    except (OSError, ValueError):
        raise JobFailure("runtime_error", "Ollama could not publish the model under its final name.") from None


def ollama_delete(host: str, name: str, opener=None) -> None:
    """Best effort: removes a model this export created (its provisional one, or its final one after a copy that
    was dispatched before a cancel was seen)."""
    try:
        _http(host, "/api/delete", {"model": name}, method="DELETE", opener=opener, timeout=60)
    except (OSError, ValueError):
        pass


def ollama_chat(host: str, model: str, messages: list[dict], cancelled=None, timeout=CHAT_SECONDS) -> dict:
    """One /api/chat request on its own connection, with the job's cancel flag looked at while Ollama is answering.
    Every packet of the reply (status line, headers, body) is awaited through the cooperative transport, so a
    cancel ends the wait within a slice wherever the reply stands, the connection is shut down (the daemon sees its
    client go) and `Cancelled` is raised. An answer that arrives after the cancel was seen is not used either.
    http.client follows no redirect, nothing is retried, the whole request is bounded by `timeout` and the reply
    by `MAX_REPLY_BYTES`. The reply is returned as parsed JSON; its shape is checked by `chat_reply`."""
    u = urllib.parse.urlsplit(host)
    body = json.dumps({"model": model, "messages": messages, "stream": False, "think": False,
                       "options": {"temperature": 0, "seed": 7, "num_predict": 160}}).encode()
    conn = http.client.HTTPConnection(u.hostname, u.port, timeout=timeout)
    deadline = time.monotonic() + timeout
    try:
        res = exchange(conn, "POST", "/api/chat", body, {"content-type": "application/json"}, cancelled, deadline,
                       lambda: JobFailure("timeout", f"Ollama on this machine took too long to answer for {model}."))
        status, raw = res.status, res.read(MAX_REPLY_BYTES + 1)
    except (OSError, http.client.HTTPException):
        if cancelled is not None and cancelled.is_set():
            raise Cancelled() from None
        raise JobFailure("runtime_error", f"Ollama on this machine did not answer for {model}.") from None
    finally:
        shutdown(conn)
    if cancelled is not None and cancelled.is_set():
        raise Cancelled()  # the answer came after the cancel was seen; it is not used
    if status != 200:
        raise JobFailure("runtime_error", f"Ollama on this machine refused a load-test request for {model} (HTTP {status}).")
    if len(raw) > MAX_REPLY_BYTES:
        raise JobFailure("runtime_error", f"Ollama on this machine returned a malformed reply for {model}.")
    try:
        return json.loads(raw)
    except ValueError:
        raise JobFailure("runtime_error", f"Ollama on this machine returned a malformed reply for {model}.") from None


def chat_reply(reply, model: str) -> tuple[str, int, int]:
    """The answer and Ollama's two counters (tokens, nanoseconds) from one /api/chat reply. A reply of another shape
    is a clear failure: no exception from inside the parser, and no speed computed from a counter that is not one."""
    malformed = JobFailure("runtime_error", f"Ollama on this machine returned a malformed reply for {model}.")
    if not isinstance(reply, dict):
        raise malformed
    message = reply.get("message", {})
    content = message.get("content", "") if isinstance(message, dict) else None
    if not isinstance(content, str):
        raise malformed
    counters = []
    for key in ("eval_count", "eval_duration"):
        value = reply.get(key, 0)  # Ollama leaves a zero counter out
        if type(value) is not int or not 0 <= value <= MAX_COUNTER:  # no bool, float, NaN, negative or absurd value
            raise malformed
        counters.append(value)
    return content.strip()[:600], counters[0], counters[1]


def load_test(host: str, model: str, conversations: list[list[dict]], cancelled=None) -> dict:
    """The same held-out conversations, greedy decoding; speed from Ollama's own counters (nanoseconds). The cancel
    flag is looked at before each request, while Ollama answers it, and before its answer and counters are kept."""
    answers, tokens, eval_ns = [], 0, 0
    for turns in conversations:
        if cancelled is not None and cancelled.is_set():
            raise Cancelled()
        try:
            r = ollama_chat(host, model, turns, cancelled)
        except (OSError, ValueError):
            raise JobFailure("runtime_error", f"Ollama on this machine did not answer for {model}.") from None
        answer, count, ns = chat_reply(r, model)
        answers.append(answer)
        tokens += count
        eval_ns += ns
    return {"model": model, "tokensPerSec": round(tokens / (eval_ns / 1e9), 1) if eval_ns else None, "answers": answers}


def ollama_create(name: str, folder: Path, host: str, cancelled, popen=subprocess.Popen, seconds=CREATE_SECONDS) -> None:
    """Native Ollama: `ollama create` reads the Modelfile next to the GGUF and stores the model. It is sent to the
    validated target only, and its client is killed if the job is cancelled or the time is up; the wait for the
    killed client is bounded, and the job ends cancelled or timed out either way. Killing the client does not
    prove the daemon dropped the create, so the caller treats the name as possibly created."""
    if cancelled.is_set():
        raise Cancelled()
    env = {**os.environ, "OLLAMA_HOST": host}
    proc = popen(["ollama", "create", name, "-f", str(folder / "Modelfile")], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
    deadline = time.monotonic() + seconds
    while proc.poll() is None:
        if cancelled.wait(0.5) or time.monotonic() > deadline:
            proc.kill()
            try:
                proc.wait(timeout=STOP_SECONDS)
            except subprocess.TimeoutExpired:
                pass  # a client that will not go does not change the outcome
            if cancelled.is_set():
                raise Cancelled()
            raise JobFailure("timeout", "Ollama took too long to create the model.")
    if proc.returncode != 0:
        raise JobFailure("runtime_error", "Ollama could not create the model.")


# --- Lineage

def _lost(message: str) -> JobFailure:
    return JobFailure("model_unavailable", message)


def readable_manifest(manifest) -> bool:
    """Whether this is a training manifest of the schema this runner writes, with every field export reads below."""
    if not isinstance(manifest, dict) or manifest.get("schema") != "valcairn.training/1":
        return False
    adapter, base = manifest.get("adapter"), manifest.get("baseModel")
    return (isinstance(adapter, dict) and isinstance(adapter.get("files"), dict)
            and isinstance(manifest.get("splitSha256"), str) and isinstance(manifest.get("dataFiles"), dict)
            and isinstance(base, dict) and isinstance(base.get("source"), str) and isinstance(base.get("files"), dict))


def verified_training(home: Path, source: dict) -> tuple[Path, dict]:
    """The training run's folder and manifest, if everything export will use still matches what was frozen. Every
    folder hashed or mounted here is checked to be a real folder inside the runner home, not a link elsewhere."""
    train_id, rel = source.get("trainJobId"), source.get("adapterLocation") or ""
    m = re.fullmatch(r"jobs/([0-9a-f-]{36})/attempt-([1-9]|10)/out/adapter", rel)
    if not isinstance(train_id, str) or not JOB_ID.fullmatch(train_id) or not m or m.group(1) != train_id:
        raise _lost("The training run's adapter is not on this runner.")
    train_dir = attempt_dir(home, train_id, int(m.group(2)))
    out, data_dir = train_dir / "out", train_dir / "data"
    for path in (out, out / "adapter", out / "manifest.json", out / "split.json", data_dir):
        confined(home, path)
    if not (out / "adapter" / "adapter_model.safetensors").is_file():
        raise _lost("The training run's adapter is not on this runner.")
    expected = source.get("trainingManifestSha256")
    if not isinstance(expected, str) or not (out / "manifest.json").is_file():
        raise _lost("This training run has no verified lineage on this runner; train again before exporting.")
    if sha256_file(out / "manifest.json") != expected:
        raise _lost("The training manifest on this runner is not the one Valcairn recorded.")
    try:
        manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    except ValueError:
        manifest = None
    if not readable_manifest(manifest):
        raise _lost("The training manifest on this runner is not one this runner can read; train again before exporting.")
    if manifest.get("trainJobId") != train_id:
        raise _lost("The training manifest names another training run.")
    if file_hashes(out / "adapter") != manifest["adapter"]["files"] or manifest["adapter"]["files"].get("adapter_model.safetensors") != source.get("adapterSha256"):
        raise _lost("The adapter, its config or its tokenizer changed since training.")
    if not (out / "split.json").is_file() or sha256_file(out / "split.json") != manifest["splitSha256"]:
        raise _lost("The training split changed since training, so its held-out examples cannot be trusted.")
    data = {p.name: sha256_file(p) for p in data_dir.iterdir() if is_data_file(p)} if data_dir.is_dir() else {}
    if data != manifest["dataFiles"]:
        raise _lost("The dataset files of the training run changed since training.")
    return train_dir, manifest


def base_model_for(home: Path, manifest: dict, spec_source: str) -> Path:
    base = manifest["baseModel"]
    if base["source"] != spec_source:
        raise _lost("This export names another base model than the one the adapter was trained on.")
    model_dir = confined(home, cache_dir(home, base["source"], base.get("revision")) / "model")
    record = verified_cache(model_dir, base["source"], base.get("revision"))
    if not record or record["files"] != base["files"]:
        raise _lost("The base model on this runner differs from the one the adapter was trained on.")
    return model_dir


def held_out(train_dir: Path) -> tuple[list[list[dict]], str | None]:
    """Up to three held-out conversations, without their reference answers, found through the training run's own
    split (the same example rules as train.py), and the system prompt if every example used the same one."""
    split = json.loads((train_dir / "out" / "split.json").read_text(encoding="utf-8"))
    if not isinstance(split, dict) or not all(isinstance(split.get(k), list) for k in ("train", "heldOut")):
        raise _lost("The training split on this runner is not one this runner can read; train again before exporting.")
    held = {h for h in split["heldOut"] if isinstance(h, str)} - {t for t in split["train"] if isinstance(t, str)}
    conversations, systems = [], set()
    for path in sorted(p for p in (train_dir / "data").iterdir() if is_data_file(p)):
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            try:
                ex = normalise(json.loads(line))
            except ValueError:
                ex = None
            if ex is None:
                continue  # skipped by training as well
            messages = ex["messages"]
            systems.add(messages[0]["content"] if messages[0]["role"] == "system" else None)
            if len(conversations) < MAX_PROMPTS and digest(ex) in held:
                conversations.append(prompt_turns(ex))
    return conversations, (next(iter(systems)) if len(systems) == 1 else None)


# --- Conversion

def convert(ctx, home: Path, src: Path, out: Path, name: str) -> tuple[Path, str]:
    """GGUF from a Hugging Face folder, written under a .part name and moved into place only when complete."""
    check(ctx)
    out.mkdir(parents=True, exist_ok=True)
    part, gguf = confined(home, out / f"{name}.part"), confined(home, out / name)
    step = Step(image=ctx.settings.convert_image, command=["python3", "/app/convert_hf_to_gguf.py", "/in/hf", "--outtype", QUANT, "--outfile", f"/out/{name}.part"],
                inputs={str(src): "/in/hf"}, output=str(out), env={"HOME": "/tmp", "HF_HOME": "/tmp/hf"},
                # The llama.cpp image's entrypoint is its own tool launcher; the converter is run directly instead.
                entrypoint="", limits=Limits(cpus=8, memory="16g", seconds=3600, tmpfs_mb=1024))
    try:
        code = ctx.sandbox.run(step, lambda line: forward(ctx, line), ctx.cancelled)
        if code != 0 or not part.is_file():
            raise JobFailure("runtime_error", f"GGUF conversion failed with exit code {code}.")
        sha = sha256_file(part)
        part.replace(gguf)
        return gguf, sha
    finally:
        part.unlink(missing_ok=True)


def base_gguf(ctx, home: Path, model_dir: Path, base_files: dict) -> tuple[Path, str]:
    """The base model as GGUF, converted once per runner for these exact input files, converter and quantization, and
    checked against its record on every reuse."""
    identity = sha256_json({"files": base_files, "converter": ctx.settings.convert_image, "quantization": QUANT})[:24]
    folder = confined(home, model_dir.parent / "gguf")
    gguf, record = folder / f"base-{identity}-{QUANT}.gguf", folder / f"base-{identity}.json"
    if gguf.exists():
        try:
            recorded = json.loads(record.read_text(encoding="utf-8")).get("sha256")
        except (OSError, ValueError, AttributeError):
            recorded = None
        if recorded is None or sha256_file(gguf) != recorded:
            raise _lost("The cached base GGUF does not match its record; remove it from the runner and export again.")
        return gguf, recorded
    path, sha = convert(ctx, home, model_dir, folder, gguf.name)
    record.write_text(json.dumps({"sha256": sha, "identity": identity, "converter": ctx.settings.convert_image, "quantization": QUANT}), encoding="utf-8")
    return path, sha


def modelfile(folder: Path, gguf: Path, system: str | None = None) -> Path:
    text = f"FROM ./{gguf.name}\nPARAMETER temperature 0.2\n"
    if system:
        # The system prompt every training example used, so plain chat with the model behaves as it was trained.
        text += 'SYSTEM """' + system.replace('"""', "'''") + '"""\n'
    (folder / "Modelfile").write_text(text, encoding="utf-8")
    return folder


# --- The job

def export(ctx) -> dict:
    source = ctx.spec.get("source") or {}
    home = runner_home(ctx.settings)
    host = local_ollama(ctx.settings.ollama_host)
    work = attempt_dir(home, ctx.job["id"], ctx.job["attempt"])
    train_dir, manifest = verified_training(home, source)
    model_dir = base_model_for(home, manifest, ctx.spec["baseModel"]["source"])
    adapter_dir = train_dir / "out" / "adapter"
    base_source = manifest["baseModel"]["source"]

    job, attempt = ctx.job["id"], ctx.job["attempt"]
    provisional, final = f"valcairn-p-{job}-a{attempt}", f"valcairn-{job}-a{attempt}"
    created: list[str] = []  # names this attempt made (or started to make) and removes on failure; nothing else
    remove(home, work)
    try:
        for name in (provisional, final):
            if ollama_has(host, name):
                raise JobFailure("runtime_error", f"An Ollama model named {name} already exists; it is left as it is.")
        check(ctx)
        (work / "merged").mkdir(parents=True)
        merge = Step(image=ctx.settings.train_image, command=["python", "merge.py"], gpus=bool(ctx.capabilities.get("gpus")),
                     inputs={str(model_dir): "/in/model", str(adapter_dir): "/in/adapter"}, output=str(work / "merged"),
                     limits=Limits(cpus=8, memory=ctx.settings.train_memory, seconds=3600, tmpfs_mb=2048, exec_cache_mb=1024, shm="2g"))
        if ctx.sandbox.run(merge, lambda line: forward(ctx, line), ctx.cancelled) != 0:
            raise JobFailure("runtime_error", "Merging the adapter failed.")

        ctx.emit("stage", name="convert", status="started")
        tuned_dir = work / "gguf"
        tuned, tuned_sha = convert(ctx, home, work / "merged" / "merged", tuned_dir, f"model-{QUANT}.gguf")
        remove(home, work / "merged")  # merged full weights are transient
        # The base model, converted the same way, so the comparison is like for like.
        base, base_sha = base_gguf(ctx, home, model_dir, manifest["baseModel"]["files"])
        ctx.emit("stage", name="convert", status="finished")

        base_name = f"valcairn-base-{base_sha[:16]}"
        conversations, system = held_out(train_dir)
        ctx.emit("stage", name="ollama_create", status="started")
        check(ctx)
        # The provisional name was free a moment ago, so whatever appears under it from here on is this attempt's,
        # including a model the daemon finishes after a cancelled create; it is listed before the create for that.
        created.append(provisional)
        ollama_create(provisional, modelfile(tuned_dir, tuned, system), host, ctx.cancelled)
        check(ctx)
        # The base model is named by its GGUF's SHA-256, so an existing one holds exactly these bytes and is shared.
        if not ollama_has(host, base_name):
            ollama_create(base_name, modelfile(base.parent, base), host, ctx.cancelled)
        ctx.emit("stage", name="ollama_create", status="finished")

        # Both models answer the same held-out conversations, system prompt included, as they would in use.
        ctx.emit("stage", name="load_test", status="started")
        started = time.time()
        tuned_test = load_test(host, provisional, conversations, ctx.cancelled)
        base_test = load_test(host, base_name, conversations, ctx.cancelled)
        for name, test in (("tuned_tokens_per_sec", tuned_test), ("base_tokens_per_sec", base_test)):
            if test["tokensPerSec"] is not None:  # an unknown speed (no counters) is not reported as a measured zero
                ctx.emit("metric", name=name, value=test["tokensPerSec"])
        ctx.emit("stage", name="load_test", status="finished")

        # Publish: the final name appears only now, never over an existing model, and never once a cancel is known.
        check(ctx)
        if ollama_has(host, final):
            raise JobFailure("runtime_error", f"An Ollama model named {final} appeared during the export; it is left as it is.")
        check(ctx)  # the lookup blocked; a cancel seen meanwhile means no publication at all
        created.append(final)  # the copy is this attempt's publication: if the attempt does not finish, it goes too
        ollama_copy(host, provisional, final)
        ollama_delete(host, provisional)
        created.remove(provisional)
        # The copy is dispatched and cannot be undone atomically. A cancel seen now still ends the attempt before any
        # artifact is written: the cleanup below removes the copied model (best effort) and the working files.
        check(ctx)

        ctx.emit("artifact", name=tuned.name, sha256=tuned_sha, sizeBytes=tuned.stat().st_size)
        result_manifest = {
            "schema": "valcairn.export/2", "createdAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "trainJobId": source["trainJobId"], "trainingManifestSha256": source["trainingManifestSha256"],
            "baseModel": {"id": ctx.spec["baseModel"]["id"], "source": base_source, "revision": manifest["baseModel"].get("resolvedRevision"), "license": ctx.spec["baseModel"].get("license")},
            "adapter": {"sha256": source["adapterSha256"]},
            "gguf": {"file": tuned.name, "sha256": tuned_sha, "sizeBytes": tuned.stat().st_size, "quantization": QUANT},
            "baseGguf": {"sha256": base_sha}, "converter": ctx.settings.convert_image,
            "ollama": {"model": final, "baseModel": base_name},
        }
        (tuned_dir / "manifest.json").write_text(json.dumps(result_manifest, indent=2), encoding="utf-8")
        (tuned_dir / "MODEL_CARD.md").write_text(
            f"# {final}\n\nFine-tuned with LoRA by Valcairn from `{base_source}` ({result_manifest['baseModel']['license']}).\n\n"
            f"- Training run: `{source['trainJobId']}`\n- Training manifest SHA-256: `{source['trainingManifestSha256']}`\n"
            f"- Adapter SHA-256: `{source['adapterSha256']}`\n- GGUF ({QUANT}) SHA-256: `{tuned_sha}`\n\n"
            "The load test only shows speed and a few held-out answers from the training dataset. Keep the base model's license "
            "with any copy of these weights, and evaluate on your own cases before relying on it.\n", encoding="utf-8")
        license_file = model_dir / "LICENSE"
        if license_file.is_file():
            (tuned_dir / "LICENSE").write_bytes(license_file.read_bytes())
        return {
            "ollamaModel": final, "gguf": result_manifest["gguf"], "manifestSha256": sha256_file(tuned_dir / "manifest.json"),
            "trainingManifestSha256": source["trainingManifestSha256"], "baseGgufSha256": base_sha,
            "loadTest": {"conversations": len(conversations), "seconds": round(time.time() - started, 1),
                         "tuned": {"model": final, "tokensPerSec": tuned_test["tokensPerSec"]}, "base": {"model": base_name, "tokensPerSec": base_test["tokensPerSec"]}},
            "samples": [{"prompt": next(m["content"] for m in reversed(turns) if m["role"] == "user")[:300], "base": b[:400], "tuned": t[:400]}
                        for turns, b, t in zip(conversations, base_test["answers"], tuned_test["answers"])],
            "location": f"jobs/{job}/attempt-{attempt}/gguf",
        }
    except BaseException:
        for name in created:
            ollama_delete(host, name)  # only what this attempt created
        remove(home, work)
        raise
