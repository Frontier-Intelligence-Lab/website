"""Shared fakes for the train and export handlers: a sandbox that writes what the real images would (using the real
example rules for the split), signed dataset links served from memory, and an Ollama that keeps models in a dict.
Nothing here starts Docker, downloads a model or talks to a real Ollama."""

import hashlib
import io
import json
import tempfile
import threading
from pathlib import Path

from valcairn_runner import examples, export as exporter, training
from valcairn_runner.runner import Settings
from valcairn_runner.sandbox import Cancelled

TRAIN_JOB = "a1b2c3d4-0000-4000-8000-0000000000aa"
EXPORT_JOB = "e1234567-0000-4000-8000-0000000000bb"
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
                "datasets": [{"projectId": "p", "version": 1, "files": [{"id": "f1", "filename": "CHATS.JSONL", "sha256": hashlib.sha256(self.body).hexdigest(), "url": "http://ingest/x"}]}]}


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


class Ollama:
    """Models in a dict; records every call. Patched over the export module's Ollama functions."""

    def __init__(self, existing=()):
        self.models = {name: "user-made" for name in existing}
        self.calls = []

    def install(self, test):
        saved = {n: getattr(exporter, n) for n in ("ollama_has", "ollama_copy", "ollama_delete", "ollama_create", "load_test")}
        test.addCleanup(lambda: [setattr(exporter, n, f) for n, f in saved.items()])
        exporter.ollama_has = lambda host, name, opener=None: (self.calls.append(("has", host, name)), name in self.models)[1]
        exporter.ollama_copy = lambda host, a, b, opener=None: (self.calls.append(("copy", host, a, b)), self.models.__setitem__(b, self.models[a]))
        exporter.ollama_delete = lambda host, name, opener=None: (self.calls.append(("delete", host, name)), self.models.pop(name, None))
        exporter.ollama_create = self.create
        exporter.load_test = self.load_test
        return self

    def create(self, name, folder, host, cancelled):
        if cancelled.is_set():
            raise AssertionError("ollama create ran after cancellation")
        self.calls.append(("create", host, name))
        self.models[name] = (folder / "Modelfile").read_text()

    def load_test(self, host, model, conversations, cancelled=None, opener=None):
        if cancelled is not None and cancelled.is_set():
            raise Cancelled()  # what the real load test does before sending anything
        self.calls.append(("load", host, model))
        return {"model": model, "tokensPerSec": 100.0, "answers": [f"{model} says {c[-1]['content']}" for c in conversations]}


def serve_data(test, body=DATA):
    real = training.urllib.request.urlopen
    training.urllib.request.urlopen = lambda url, timeout: io.BytesIO(body)
    test.addCleanup(lambda: setattr(training.urllib.request, "urlopen", real))


def trained(test, home=None, job_id=TRAIN_JOB):
    """A finished training run on disk, made by the real train handler, and its result."""
    home = Path(home or tempfile.mkdtemp())
    serve_data(test)
    result = training.train(Ctx(home, job_id, api=Inputs()))
    return home, result


def export_spec(result, train_id=TRAIN_JOB):
    return {"source": {"trainJobId": train_id, "adapterSha256": result["adapter"]["sha256"], "adapterLocation": result["adapter"]["location"],
                       "trainingManifestSha256": result["trainingManifestSha256"]},
            "baseModel": {"id": "m", "source": "org/model", "license": "Apache 2.0"}}
