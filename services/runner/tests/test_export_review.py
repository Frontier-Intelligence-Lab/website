"""Regressions for the independent PR16 review (comment 6638291593) that exercise the export handler. Each one
fails on a6e3513 and passes after. The train handler's live in test_training_review.py, the shared example rules'
in test_examples.py. Only temporary folders, in-memory fakes and the real stdlib helpers are used: no Docker,
model, GPU or Ollama."""

import json
import os
import tempfile
import threading
import unittest
from pathlib import Path

from fixtures_export import EXPORT_JOB, Ollama, export_spec
from fixtures_runner import TRAIN_JOB, Box, Ctx, trained
from valcairn_runner import export as exporter
from valcairn_runner.sandbox import Cancelled
from valcairn_runner.training import JobFailure

HERE = Path(__file__).resolve().parent.parent


class ExportLineage(unittest.TestCase):
    """4, 5: only the adapter weights were checked; split.json, the base weights and the base GGUF were not bound."""

    def setUp(self):
        self.home, self.result = trained(self)
        self.ollama = Ollama().install(self)
        self.train_out = self.home / "jobs" / TRAIN_JOB / "attempt-1" / "out"

    def export(self, job=EXPORT_JOB, attempt=1):
        return exporter.export(Ctx(self.home, job, attempt, spec=export_spec(self.result), kind="export"))

    def assert_refused(self, why):
        with self.assertRaises(JobFailure, msg=why) as e:
            self.export()
        self.assertEqual(e.exception.category, "model_unavailable", why)
        self.assertEqual(self.ollama.models, {}, f"{why}: nothing reached Ollama")

    def test_an_edited_split_is_refused(self):
        split = json.loads((self.train_out / "split.json").read_text())
        split["heldOut"].append(split["train"][0])  # make a trained row look held out
        (self.train_out / "split.json").write_text(json.dumps(split))
        self.assert_refused("split")

    def test_changed_base_weights_config_or_tokenizer_are_refused(self):
        for name in ("model.safetensors", "config.json", "tokenizer.json"):
            path = next((self.home / "models").rglob(name))
            original = path.read_bytes()
            path.write_bytes(original + b" ")
            self.assert_refused(name)
            path.write_bytes(original)

    def test_a_changed_adapter_config_manifest_or_dataset_file_is_refused(self):
        for path in (self.train_out / "adapter" / "adapter_config.json", self.train_out / "manifest.json", next((self.train_out.parent / "data").iterdir())):
            original = path.read_bytes()
            path.write_bytes(original + b"\n")
            self.assert_refused(path.name)
            path.write_bytes(original)

    def test_an_altered_cached_base_gguf_is_refused_not_reused(self):
        self.export()
        base = next((self.home / "models").rglob("base-*.gguf"))
        base.write_bytes(b"something else")
        with self.assertRaises(JobFailure) as e:
            self.export(job=EXPORT_JOB[:-1] + "d")
        self.assertEqual(e.exception.category, "model_unavailable")


class CancellationBeforeNativeWork(unittest.TestCase):
    """6: a cancel at the end of conversion still ran two Ollama creates and both load tests, then succeeded."""

    def test_cancel_at_conversion_end_creates_and_tests_nothing(self):
        home, result = trained(self)
        ollama = Ollama().install(self)
        cancelled = threading.Event()

        def cancel_on_convert(step, _):
            if "/app/convert_hf_to_gguf.py" in step.command:
                cancelled.set()
            return None
        ctx = Ctx(home, EXPORT_JOB, spec=export_spec(result), sandbox=Box(cancel_on_convert), kind="export")
        ctx.cancelled = cancelled
        with self.assertRaises(Cancelled):
            exporter.export(ctx)
        self.assertEqual([c for c in ollama.calls if c[0] in ("create", "load", "copy")], [])

    def test_ollama_create_is_stopped_when_the_job_is_cancelled(self):
        class Proc:
            killed = False

            def poll(self):
                return 0 if self.killed else None

            def kill(self):
                self.killed = True

            def wait(self, timeout=None):
                return 0
        proc, cancelled = Proc(), threading.Event()
        threading.Timer(0.1, cancelled.set).start()
        with self.assertRaises(Cancelled):
            exporter.ollama_create("m", Path(tempfile.mkdtemp()), "http://127.0.0.1:11434", cancelled, popen=lambda *a, **k: proc)
        self.assertTrue(proc.killed)
        launched = []
        with self.assertRaises(Cancelled):
            exporter.ollama_create("m", Path(tempfile.mkdtemp()), "http://127.0.0.1:11434", cancelled, popen=lambda *a, **k: launched.append(a))
        self.assertEqual(launched, [], "nothing is launched once cancelled")


class OneLocalOllama(unittest.TestCase):
    """7: the CLI inherited OLLAMA_HOST while HTTP used the setting, and neither had to be this machine."""

    def test_only_loopback_http_is_accepted(self):
        for ok, want in [("http://127.0.0.1:11434", "http://127.0.0.1:11434"), ("http://localhost:1234/", "http://localhost:1234"), ("http://[::1]:11434", "http://[::1]:11434"), ("http://127.0.0.1", "http://127.0.0.1:11434")]:
            self.assertEqual(exporter.local_ollama(ok), want)
        for bad in ["https://ollama.com", "http://10.0.0.5:11434", "http://127.0.0.1.evil.example:11434", "http://user:pw@127.0.0.1:11434", "http://127.0.0.1:11434/proxy", "file:///x", "http://127.0.0.1:99999"]:
            with self.assertRaises(JobFailure, msg=bad):
                exporter.local_ollama(bad)

    def test_the_cli_gets_the_validated_target_not_the_inherited_one(self):
        seen = {}

        class Proc:
            returncode = 0

            def poll(self):
                return 0

        def popen(args, **kwargs):
            seen.update(kwargs["env"])
            return Proc()
        os.environ["OLLAMA_HOST"] = "http://203.0.113.9:11434"
        try:
            exporter.ollama_create("m", Path(tempfile.mkdtemp()), "http://127.0.0.1:11434", threading.Event(), popen=popen)
        finally:
            del os.environ["OLLAMA_HOST"]
        self.assertEqual(seen["OLLAMA_HOST"], "http://127.0.0.1:11434")

    def test_export_refuses_a_remote_target_before_any_work(self):
        home, result = trained(self)
        ctx = Ctx(home, EXPORT_JOB, spec=export_spec(result), kind="export")
        ctx.settings.ollama_host = "http://192.0.2.10:11434"
        with self.assertRaises(JobFailure):
            exporter.export(ctx)
        self.assertEqual(ctx.sandbox.steps, [])


class ProvisionalIdentities(unittest.TestCase):
    """8: a retry could replace the same local model name before its checks passed."""

    def test_a_failed_retry_never_replaces_an_earlier_result_or_a_user_model(self):
        home, result = trained(self)
        ollama = Ollama().install(self)
        first = exporter.export(Ctx(home, EXPORT_JOB, 1, spec=export_spec(result), kind="export"))
        published = dict(ollama.models)
        real = ollama.load_test

        def failing(host, model, conversations, cancelled=None, opener=None):
            if model.startswith("valcairn-p-"):
                raise JobFailure("runtime_error", "load test failed")
            return real(host, model, conversations, cancelled)
        exporter.load_test = failing
        with self.assertRaises(JobFailure):
            exporter.export(Ctx(home, EXPORT_JOB, 2, spec=export_spec(result), kind="export"))
        self.assertEqual(ollama.models, published, "the earlier model is untouched and the failed attempt left nothing")
        self.assertEqual(first["ollamaModel"], f"valcairn-{EXPORT_JOB}-a1")
        exporter.load_test = real
        ollama.models[f"valcairn-{EXPORT_JOB}-a3"] = "user-made"
        with self.assertRaises(JobFailure):
            exporter.export(Ctx(home, EXPORT_JOB, 3, spec=export_spec(result), kind="export"))
        self.assertEqual(ollama.models[f"valcairn-{EXPORT_JOB}-a3"], "user-made", "an existing model is never overwritten")


class HonestClaims(unittest.TestCase):
    """11: held-out wording overclaimed."""

    def test_no_never_trained_on_claims_remain(self):
        for path in [HERE / "images" / "train" / "train.py", HERE / "valcairn_runner" / "export.py", HERE / "README.md"]:
            self.assertNotIn("never trained on", path.read_text(encoding="utf-8").lower(), path.name)


if __name__ == "__main__":
    unittest.main()
