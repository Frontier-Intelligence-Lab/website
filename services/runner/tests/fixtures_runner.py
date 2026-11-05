"""Shared fakes for the train handler (the export fakes build on these in fixtures_export.py): a job context, a
sandbox that writes what the real images would (using the real example rules for the split), and signed dataset
links served from memory. Nothing here starts Docker, downloads a model or talks to a real Ollama, and nothing here
imports the export handler, so the training unit's tests run without it."""

import hashlib
import io
import json
import tempfile
import threading
from pathlib import Path

from valcairn_runner import examples, training
from valcairn_runner.runner import Settings

TRAIN_JOB = "a1b2c3d4-0000-4000-8000-0000000000aa"
SYSTEM = "Be Acme support."
ROWS = [{"messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": f"question {i}"}, {"role": "assistant", "content": f"answer {i}"}]} for i in range(30)]
JUNK = ['{"messages": "not a list"}', '{"messages": [{"role": "assistant", "content": "no question"}]}', "not json", "[1, 2]", "null", "7"]
DATA = ("\n".join([*JUNK, *(json.dumps(r) for r in ROWS)]) + "\n").encode()


class Ctx:
    def __init__(self, home, job_id, attempt=1, spec=None, sandbox=None, api=None, kind="train"):
        self.settings = Settings(home=str(home))
        self.capabilities = {"gpus": [{"name": "GPU", "memoryMb": 1}]}
        self.job = {"id": job_id, "attempt": attempt, "leaseToken": "t", "kind": kind}
        self.spec = spec if spec is not None else {"plan": {"steps": ["sft"]}}
        self.cancelled = threading.Event()
        self.events = []
        self.sandbox = sandbox or Box()
        self.api = api

    def emit(self, kind, **data):
        self.events.append((kind, data))

    def log(self, message, level="info"):
        self.emit("log", level=level, message=message)


class Inputs:
    def __init__(self, source="org/model", body=DATA):
        self.source, self.body = source, body

    def inputs(self, job_id, token):
        return {"baseModel": {"id": "m", "source": self.source},
                "datasets": [{"projectId": "p", "version": 1, "files": [{"id": "f1", "filename": "CHATS.JSONL", "sha256": hashlib.sha256(self.body).hexdigest(), "url": "https://ingest.example/x"}]}]}


class Box:
    """Fetch, train (with the real split rules), merge and convert, writing what the images would."""

    def __init__(self, on_step=None):
        self.steps, self.on_step = [], on_step

    def stop(self):
        pass

    def run(self, step, on_line, cancelled):
        self.steps.append(step)
        if self.on_step:
            code = self.on_step(step, cancelled)
            if code is not None:
                return code
        out = Path(step.output)
        last = step.command[-1]
        if last == "fetch.py":
            (out / "model").mkdir(parents=True, exist_ok=True)
            (out / "model" / "model.safetensors").write_bytes(b"weights")
            (out / "model" / "config.json").write_text('{"arch": 1}')
            (out / "model" / "tokenizer.json").write_text('{"tok": 1}')
            (out / "model" / "LICENSE").write_text("license")
            (out / "source.json").write_text(json.dumps({"source": step.env["VALCAIRN_MODEL_SOURCE"], "resolvedRevision": "c" * 40}))
        elif last == "train.py":
            data = next(Path(h) for h, inside in step.inputs.items() if inside == "/in/data")
            rows, _ = examples.load_examples(data)
            train_rows, held_rows = examples.split(rows)
            (out / "adapter").mkdir()
            (out / "adapter" / "adapter_model.safetensors").write_bytes(b"adapter")
            (out / "adapter" / "adapter_config.json").write_text("{}")
            (out / "split.json").write_text(json.dumps({"train": [examples.digest(e) for e in train_rows], "heldOut": [examples.digest(e) for e in held_rows]}))
            (out / "report.json").write_text(json.dumps({"method": "sft-lora", "rank": 32, "alpha": 64, "epochs": 2, "steps": 10, "trainExamples": len(train_rows),
                                                         "heldOutExamples": len(held_rows), "skippedLines": 6, "baseHeldOutLoss": 2.0, "tunedHeldOutLoss": 1.0,
                                                         "trainSeconds": 3.0, "gpus": ["GPU"], "peakGpuMemoryMb": 10}))
        elif last == "merge.py":
            (out / "merged").mkdir(parents=True, exist_ok=True)
        else:  # the GGUF converter writes /out/<name>.part
            tuned = Path(next(iter(step.inputs))).name == "merged"
            (out / last.split("/")[-1]).write_bytes(b"gguf-tuned" if tuned else b"gguf-base")
        return 0


def serve_data(test, body=DATA):
    """Signed links answer from memory; the link policy in `download` still runs before this is reached."""
    real = training.open_link
    training.open_link = lambda url, *args, **kwargs: (None, io.BytesIO(body))  # no connection, the reply's bytes
    test.addCleanup(lambda: setattr(training, "open_link", real))


def trained(test, home=None, job_id=TRAIN_JOB):
    """A finished training run on disk, made by the real train handler, and its result."""
    home = Path(home or tempfile.mkdtemp())
    serve_data(test)
    result = training.train(Ctx(home, job_id, api=Inputs()))
    return home, result


def __getattr__(name):
    """The export fakes used to live here; external probes written against that layout still find them, loaded
    only when asked for. Nothing in the training unit asks, so the export module is never imported eagerly."""
    if name in ("EXPORT_JOB", "Ollama", "export_spec"):
        import fixtures_export
        return getattr(fixtures_export, name)
    raise AttributeError(name)
