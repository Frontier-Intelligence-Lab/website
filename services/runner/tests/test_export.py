import hashlib
import json
import tempfile
import threading
import unittest
from pathlib import Path

from valcairn_runner import export as exporter
from valcairn_runner.runner import Settings
from valcairn_runner.training import JobFailure

ADAPTER = b"adapter-bytes"


class Ctx:
    def __init__(self, home, sha=None, location="jobs/t1/attempt-1/out/adapter"):
        self.settings = Settings(home=str(home))
        self.capabilities = {"gpus": [{"name": "GPU", "memoryMb": 1}]}
        self.job = {"id": "e1234567-0000-4000-8000-000000000000", "attempt": 1}
        self.spec = {"source": {"trainJobId": "t1", "adapterSha256": sha or hashlib.sha256(ADAPTER).hexdigest(), "adapterLocation": location},
                     "baseModel": {"id": "m", "source": "org/model", "license": "Apache 2.0"}}
        self.cancelled = threading.Event()
        self.events = []
        self.sandbox = Box()

    def emit(self, kind, **data):
        self.events.append((kind, data))

    def log(self, message, level="info"):
        self.emit("log", level=level, message=message)


class Box:
    def __init__(self):
        self.steps = []

    def run(self, step, on_line, cancelled):
        self.steps.append(step)
        out = Path(step.output)
        if step.command[-1] == "merge.py":
            (out / "merged").mkdir(parents=True, exist_ok=True)
        else:
            (out / step.command[-1].split("/")[-1]).write_bytes(b"gguf")
        return 0


def layout(home: Path):
    train = home / "jobs" / "t1" / "attempt-1"
    (train / "out" / "adapter").mkdir(parents=True)
    (train / "out" / "adapter" / "adapter_model.safetensors").write_bytes(ADAPTER)
    (train / "data").mkdir()
    rows = [{"messages": [{"role": "system", "content": "Be Acme support."}, {"role": "user", "content": f"question {i}"}, {"role": "assistant", "content": "answer"}]} for i in range(4)]
    (train / "data" / "000-x.jsonl").write_text("\n".join(json.dumps(r) for r in rows), encoding="utf-8")
    digest = lambda r: hashlib.sha256(json.dumps(r, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    (train / "out" / "split.json").write_text(json.dumps({"train": [digest(rows[0])], "heldOut": [digest(r) for r in rows[1:]]}))
    model = home / "models" / "org-model" / "model"
    model.mkdir(parents=True)
    (model / "model.safetensors").write_bytes(b"w")
    (model / "LICENSE").write_text("license")
    (model / ".valcairn-weights.json").write_text(json.dumps({"model.safetensors": hashlib.sha256(b"w").hexdigest()}))


class ExportTests(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp())
        layout(self.home)
        self.created = []
        exporter.ollama_create = lambda name, folder: self.created.append((name, (folder / "Modelfile").read_text()))
        exporter.load_test = lambda host, model, convs, opener=None: {"model": model, "tokensPerSec": 100.0, "answers": [f"{model} says {c[-1]['content']}" for c in convs]}

    def test_exports_tuned_and_base_alike_and_writes_a_manifest(self):
        ctx = Ctx(self.home)
        result = exporter.export(ctx)
        merge, tuned, base = ctx.sandbox.steps
        self.assertTrue(all(s.network == "none" for s in ctx.sandbox.steps), "no export step has network access")
        self.assertEqual(tuned.entrypoint, "", "the converter runs directly, not through the image's launcher")
        self.assertIn("q8_0", tuned.command)
        self.assertIn("q8_0", base.command, "base and tuned use the same quantization")
        self.assertEqual([n for n, _ in self.created], ["valcairn-e1234567", "valcairn-base-org-model"])
        self.assertTrue(all(m.startswith("FROM ./") for _, m in self.created))
        self.assertIn('SYSTEM """Be Acme support."""', self.created[0][1], "the training system prompt becomes the model's default")
        self.assertEqual(result["gguf"]["sha256"], hashlib.sha256(b"gguf").hexdigest())
        self.assertEqual(len(result["samples"]), 3, "held-out prompts only, from the training run's split")
        self.assertTrue(all(s["prompt"] != "question 0" for s in result["samples"]), "a trained example is never used to show the result")
        folder = self.home / result["location"]
        manifest = json.loads((folder / "manifest.json").read_text())
        self.assertEqual(manifest["adapter"]["sha256"], hashlib.sha256(ADAPTER).hexdigest())
        self.assertTrue((folder / "MODEL_CARD.md").exists() and (folder / "LICENSE").exists())
        # The base GGUF is made once per runner.
        ctx2 = Ctx(self.home)
        ctx2.job = {**ctx2.job, "id": "f1234567-0000-4000-8000-000000000000"}
        exporter.export(ctx2)
        self.assertEqual(len(ctx2.sandbox.steps), 2)

    def test_refuses_an_adapter_that_is_missing_changed_or_outside_the_runner_home(self):
        for ctx, why in [(Ctx(self.home, sha="0" * 64), "changed"), (Ctx(self.home, location="jobs/none/out/adapter"), "missing"),
                         (Ctx(self.home, location="../../../etc"), "outside")]:
            with self.assertRaises(JobFailure, msg=why) as e:
                exporter.export(ctx)
            self.assertEqual(e.exception.category, "model_unavailable")


if __name__ == "__main__":
    unittest.main()
