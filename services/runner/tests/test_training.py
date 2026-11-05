import hashlib
import io
import json
import tempfile
import threading
import unittest
from pathlib import Path

from valcairn_runner import training
from valcairn_runner.runner import Settings
from valcairn_runner.training import JobFailure, download, safe_name

JOB = "a1b2c3d4-0000-4000-8000-000000000001"
DATA = b'{"prompt":"a","completion":"b"}\n'


class Ctx:
    """Just enough of JobContext for the train handler."""

    def __init__(self, api, sandbox, home, caps=None, steps=("sft",), job_id=JOB, attempt=1):
        self.api, self.sandbox = api, sandbox
        self.settings = Settings(home=str(home))
        self.capabilities = caps if caps is not None else {"gpus": [{"name": "GPU", "memoryMb": 24000}]}
        self.job = {"id": job_id, "attempt": attempt, "leaseToken": "t", "kind": "train"}
        self.spec = {"plan": {"steps": list(steps)}}
        self.cancelled = threading.Event()
        self.events = []

    def emit(self, kind, **data):
        self.events.append((kind, data))

    def log(self, message, level="info"):
        self.emit("log", level=level, message=message)


class Api:
    def __init__(self, files, source="org/model"):
        self.files, self.source = files, source

    def inputs(self, job_id, token):
        return {"baseModel": {"id": "m", "source": self.source}, "datasets": [{"projectId": "p", "version": 1, "files": self.files}]}


class FakeSandbox:
    """Writes what the real image would, and records each step."""

    def __init__(self, train_code=0, fetch_ok=True, weights=b"w"):
        self.steps, self.train_code, self.fetch_ok, self.weights = [], train_code, fetch_ok, weights

    def stop(self):
        pass

    def run(self, step, on_line, cancelled):
        self.steps.append(step)
        if step.command[-1] == "fetch.py":
            if self.fetch_ok:
                model = Path(step.output) / "model"
                model.mkdir(parents=True, exist_ok=True)
                (model / "model.safetensors").write_bytes(self.weights)
                (model / "config.json").write_text("{}")
                (Path(step.output) / "source.json").write_text(json.dumps({"source": step.env["VALCAIRN_MODEL_SOURCE"], "resolvedRevision": "c" * 40}))
            return 0 if self.fetch_ok else 3
        on_line("loss bar 50%|#####\r@@valcairn " + json.dumps({"kind": "metric", "name": "train_loss", "value": 0.5, "step": 5}))
        on_line("ordinary output that stays local")
        if self.train_code:
            on_line("torch.OutOfMemoryError: CUDA out of memory")
            return self.train_code
        out = Path(step.output)
        (out / "adapter").mkdir()
        (out / "adapter" / "adapter_model.safetensors").write_bytes(b"adapter")
        (out / "adapter" / "adapter_config.json").write_text("{}")
        (out / "split.json").write_text(json.dumps({"train": [], "heldOut": []}))
        (out / "report.json").write_text(json.dumps({"method": "sft-lora", "rank": 32, "alpha": 64, "epochs": 2, "steps": 10, "trainExamples": 9, "heldOutExamples": 1,
                                                     "skippedLines": 0, "baseHeldOutLoss": 2.0, "tunedHeldOutLoss": 1.0, "trainSeconds": 3.0, "gpus": ["GPU"], "peakGpuMemoryMb": 10}))
        return 0


def opener_for(body):
    return lambda url, *args, **kwargs: (None, io.BytesIO(body))  # no connection, the reply's bytes


class TrainTests(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp())
        self.files = [{"id": "f1", "filename": "chats.jsonl", "sha256": hashlib.sha256(DATA).hexdigest(), "url": "https://ingest.example/x"}]
        training.open_link, self._open = opener_for(DATA), training.open_link

    def tearDown(self):
        training.open_link = self._open

    def test_fetches_once_trains_offline_and_reports_the_adapter(self):
        box = FakeSandbox()
        ctx = Ctx(Api(self.files), box, self.home, steps=("sft", "dpo"))
        result = training.train(ctx)
        fetch, train = box.steps
        self.assertEqual(fetch.network, "bridge", "only the fetch step reaches the network")
        self.assertEqual(train.network, "none")
        self.assertTrue(train.gpus)
        self.assertTrue(all(inside.startswith("/in/") for inside in train.inputs.values()), "inputs are mounted read-only under /in")
        self.assertEqual(result["tunedHeldOutLoss"], 1.0)
        self.assertEqual(result["adapter"]["sha256"], hashlib.sha256(b"adapter").hexdigest())
        self.assertEqual(result["adapter"]["configSha256"], hashlib.sha256(b"{}").hexdigest())
        self.assertIn(("stage", {"name": "dpo", "status": "skipped"}), ctx.events, "steps that do not run yet are shown as skipped")
        self.assertIn(("metric", {"name": "train_loss", "value": 0.5, "step": 5}), ctx.events, "a progress line glued to a bar redraw still arrives")
        self.assertFalse(any("ordinary output" in json.dumps(e) for e in ctx.events), "other output stays on the machine")
        self.assertEqual(result["baseModel"]["weightsSha256"], {"model.safetensors": hashlib.sha256(b"w").hexdigest()})
        self.assertEqual(result["baseModel"]["revision"], "c" * 40, "the exact fetched revision is reported")
        self.assertEqual(result["baseModel"]["configSha256"], hashlib.sha256(b"{}").hexdigest())
        manifest = self.home / "jobs" / JOB / "attempt-1" / "out" / "manifest.json"
        self.assertEqual(result["trainingManifestSha256"], hashlib.sha256(manifest.read_bytes()).hexdigest())
        box2 = FakeSandbox()
        training.train(Ctx(Api(self.files), box2, self.home, job_id=JOB[:-1] + "2"))
        self.assertEqual([s.command[-1] for s in box2.steps], ["train.py"], "cached weights are not fetched again")
        weights = next((self.home / "models").rglob("model.safetensors"))
        weights.write_bytes(b"tampered")
        box3 = FakeSandbox()
        training.train(Ctx(Api(self.files), box3, self.home, job_id=JOB[:-1] + "3"))
        self.assertEqual(box3.steps[0].command[-1], "fetch.py", "altered cached weights are fetched again, never trained on")
        self.assertFalse(list((self.home / "models").rglob("fetching-*")), "no staging folder is left behind")

    def test_several_gpus_train_through_accelerate(self):
        box = FakeSandbox()
        training.train(Ctx(Api(self.files), box, self.home, caps={"gpus": [{"name": "A", "memoryMb": 1}, {"name": "B", "memoryMb": 1}]}))
        self.assertEqual(box.steps[-1].command[:5], ["accelerate", "launch", "--multi_gpu", "--num_processes", "2"])

    def test_refusals(self):
        with self.assertRaises(JobFailure) as e:
            training.train(Ctx(Api(self.files), FakeSandbox(), self.home, steps=("dpo",)))
        self.assertEqual(e.exception.category, "unsupported")
        with self.assertRaises(JobFailure) as e:
            training.train(Ctx(Api(self.files), FakeSandbox(), self.home, caps={"gpus": []}))
        self.assertEqual(e.exception.category, "sandbox_unavailable")
        with self.assertRaises(JobFailure) as e:
            training.train(Ctx(Api([{**self.files[0], "filename": "notes.txt"}]), FakeSandbox(), self.home))
        self.assertEqual(e.exception.category, "dataset_error")
        empty = Path(tempfile.mkdtemp())
        with self.assertRaises(JobFailure) as e:
            training.train(Ctx(Api(self.files), FakeSandbox(fetch_ok=False), empty))
        self.assertEqual((e.exception.category, e.exception.retryable), ("model_unavailable", True))
        self.assertFalse(list(empty.rglob("*.safetensors")), "a failed fetch leaves nothing that looks like a cache")
        with self.assertRaises(JobFailure) as e:
            training.train(Ctx(Api(self.files), FakeSandbox(train_code=1), self.home))
        self.assertEqual(e.exception.category, "out_of_memory")
        self.assertFalse((self.home / "jobs" / JOB / "attempt-1").exists(), "a failed attempt keeps no dataset bytes")

    def test_a_file_that_does_not_match_its_checksum_is_refused(self):
        dest = self.home / "x.jsonl"
        with self.assertRaises(JobFailure) as e:
            download("https://ingest.example/x", dest, "0" * 64, opener=opener_for(DATA))
        self.assertEqual(e.exception.category, "dataset_error")
        self.assertFalse(dest.exists())
        download("https://ingest.example/x", dest, hashlib.sha256(DATA).hexdigest(), opener=opener_for(DATA))
        self.assertEqual(dest.read_bytes(), DATA)

    def test_names_are_safe_on_disk(self):
        self.assertEqual(safe_name("Org/Model 1.5B"), "Org-Model-1.5B")
        self.assertEqual(safe_name("../../etc"), "..-..-etc")
        self.assertNotIn("/", safe_name("a/b/c"))


if __name__ == "__main__":
    unittest.main()
