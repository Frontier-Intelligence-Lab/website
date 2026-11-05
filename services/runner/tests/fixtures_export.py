"""Export fakes, built on the training fakes in fixtures_runner.py: an Ollama that keeps models in a dict and the
spec Valcairn freezes into an export job. Nothing here talks to a real Ollama."""

from valcairn_runner import export as exporter
from valcairn_runner.sandbox import Cancelled

from fixtures_runner import TRAIN_JOB

EXPORT_JOB = "e1234567-0000-4000-8000-0000000000bb"


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


def export_spec(result, train_id=TRAIN_JOB):
    return {"source": {"trainJobId": train_id, "adapterSha256": result["adapter"]["sha256"], "adapterLocation": result["adapter"]["location"],
                       "trainingManifestSha256": result["trainingManifestSha256"]},
            "baseModel": {"id": "m", "source": "org/model", "license": "Apache 2.0"}}
