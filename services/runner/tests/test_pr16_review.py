"""Regressions for the independent PR16 review (comment 6638291593). Each one fails on a6e3513 and passes after.
Only temporary folders, in-memory fakes and the real stdlib helpers are used: no Docker, model, GPU or Ollama."""

import importlib.util
import json
import os
import tempfile
import threading
import unittest
from pathlib import Path

from fixtures_runner import TRAIN_JOB, Box, Ctx, Inputs, serve_data, trained
from fixtures_export import EXPORT_JOB, Ollama, export_spec
from valcairn_runner import examples, export as exporter, training
from valcairn_runner.sandbox import Cancelled
from valcairn_runner.training import JobFailure

HERE = Path(__file__).resolve().parent.parent
IMAGE_EXAMPLES = HERE / "images" / "train" / "examples.py"


def image_module():
    """The image's own example rules, loaded from the file the image copies (no ML imports)."""
    spec = importlib.util.spec_from_file_location("image_examples", IMAGE_EXAMPLES)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def chat(i, answer="a"):
    return {"messages": [{"role": "user", "content": f"q{i}"}, {"role": "assistant", "content": answer}]}


class HeldOutIntegrity(unittest.TestCase):
    """1 (P1): the fallback moved one row out of a duplicate group, so the same example was trained on and held out."""

    def test_identical_examples_stay_on_one_side_with_zero_overlap(self):
        image = image_module()
        for distinct in range(5, 40):
            rows = [chat(i) for i in range(distinct)] + [chat(0)] * 4 + [chat(1)] * 3  # duplicate groups
            train, held = image.split(rows)
            self.assertTrue(held, distinct)
            self.assertFalse({image.digest(e) for e in train} & {image.digest(e) for e in held}, f"{distinct} distinct: overlap")
            self.assertEqual(len(train) + len(held), len(rows))

    def test_five_identical_examples_fail_clearly_instead_of_leaking(self):
        image = image_module()
        with self.assertRaises(image.SplitError):
            image.split([chat(0)] * 5)
        with self.assertRaises(image.SplitError):
            image.split([chat(i) for i in range(4)] * 3)

    def test_the_overlap_check_itself_refuses(self):
        with self.assertRaises(examples.SplitError):
            examples.check_disjoint([chat(1)], [chat(1)])


class ImageParser(unittest.TestCase):
    """8: non-object JSON rows crashed the image loader; answer-first chats gave an empty prompt; .JSONL was missed."""

    def test_the_image_loader_counts_non_objects_and_bad_order_as_skipped(self):
        image = image_module()
        folder = Path(tempfile.mkdtemp())
        lines = ["[1, 2]", "null", "7", '"text"', "{not json", json.dumps({"messages": [{"role": "assistant", "content": "a"}, {"role": "user", "content": "q"}]}),
                 json.dumps({"messages": [{"role": "user", "content": "  "}, {"role": "assistant", "content": "a"}]}), json.dumps({"prompt": "", "completion": "x"}),
                 json.dumps(chat(1)), json.dumps({"prompt": "p", "completion": "c"})]
        (folder / "UPPER.JSONL").write_text("\n".join(lines), encoding="utf-8")
        (folder / "notes.txt").write_text(json.dumps(chat(9)), encoding="utf-8")
        rows, skipped = image.load_examples(folder)
        self.assertEqual((len(rows), skipped), (2, 8))
        self.assertTrue(all(image.prompt_turns(r) and any(m["role"] == "user" for m in image.prompt_turns(r)) for r in rows))

    def test_runner_and_image_rules_are_the_same_file(self):
        self.assertEqual((HERE / "valcairn_runner" / "examples.py").read_bytes(), IMAGE_EXAMPLES.read_bytes())
        self.assertIn("examples.py", (HERE / "images" / "train" / "Dockerfile").read_text(), "the image ships the shared rules")
        self.assertIn("from examples import", (HERE / "images" / "train" / "train.py").read_text())


class PathConfinement(unittest.TestCase):
    """2: a leased job id reached host paths and rmtree without validation."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.home = self.root / "home"
        self.home.mkdir()
        self.marker = self.root / "outside" / "marker"
        self.marker.parent.mkdir()
        self.marker.write_text("keep")

    def test_malformed_job_ids_and_attempts_write_and_remove_nothing(self):
        serve_data(self)
        for job_id, attempt in [("../../outside", 1), ("j1", 1), (TRAIN_JOB.upper(), 1), (TRAIN_JOB, "1"), (TRAIN_JOB, 0), (TRAIN_JOB, True), (None, 1)]:
            with self.assertRaises(JobFailure, msg=f"{job_id!r} {attempt!r}"):
                training.train(Ctx(self.home, job_id, attempt, api=Inputs()))
        self.assertEqual(self.marker.read_text(), "keep")
        self.assertEqual(list(self.home.iterdir()), [], "nothing was created")

    def test_a_link_inside_the_home_is_never_followed_for_writes_or_removal(self):
        (self.home / "jobs").symlink_to(self.marker.parent, target_is_directory=True) if hasattr(os, "symlink") else None
        if not (self.home / "jobs").is_symlink():
            self.skipTest("this machine cannot create symlinks")
        serve_data(self)
        with self.assertRaises(JobFailure):
            training.train(Ctx(self.home, TRAIN_JOB, api=Inputs()))
        self.assertEqual(sorted(p.name for p in self.marker.parent.iterdir()), ["marker"])


class CacheIdentity(unittest.TestCase):
    """3: org/model and org-model shared one cache folder; a changed config.json was accepted."""

    def test_distinct_sources_never_share_a_cache_and_any_changed_file_refetches(self):
        home = Path(tempfile.mkdtemp())
        serve_data(self)
        box = Box()
        training.train(Ctx(home, TRAIN_JOB, api=Inputs("org/model"), sandbox=box))
        box2 = Box()
        result = training.train(Ctx(home, TRAIN_JOB[:-1] + "b", api=Inputs("org-model"), sandbox=box2))
        self.assertEqual(box2.steps[0].command[-1], "fetch.py", "a different source is fetched, not reused")
        self.assertEqual(result["baseModel"]["source"], "org-model")
        self.assertEqual(len(list((home / "models").iterdir())), 2)
        config = next(p for p in (home / "models").rglob("config.json"))
        config.write_text('{"arch": 2}')
        box3 = Box()
        training.train(Ctx(home, TRAIN_JOB[:-1] + "c", api=Inputs(json.loads(config.with_name(training.SOURCE_RECORD).read_text())["source"]), sandbox=box3))
        self.assertEqual(box3.steps[0].command[-1], "fetch.py", "a changed config is not trusted")


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

            def wait(self):
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


class Cleanup(unittest.TestCase):
    """10: interrupted downloads left .part files; failed attempts kept plaintext dataset bytes."""

    def test_an_interrupted_download_leaves_no_part_file(self):
        dest = Path(tempfile.mkdtemp()) / "000.jsonl"

        class Broken:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self, n):
                raise OSError("connection reset")
        with self.assertRaises(JobFailure):  # a network error becomes a retryable dataset_error, the link never shown
            training.download("https://ingest.example/x", dest, "0" * 64, opener=lambda url, cancelled, deadline, name, context: (None, Broken()))
        self.assertEqual(list(dest.parent.iterdir()), [])

    def test_a_cancelled_training_attempt_keeps_no_dataset_bytes(self):
        home = Path(tempfile.mkdtemp())
        serve_data(self)
        ctx = Ctx(home, TRAIN_JOB, api=Inputs(), sandbox=Box(lambda step, c: (_ for _ in ()).throw(Cancelled()) if step.command[-1] == "train.py" else None))
        with self.assertRaises(Cancelled):
            training.train(ctx)
        self.assertFalse((home / "jobs" / TRAIN_JOB / "attempt-1").exists())


class HonestClaims(unittest.TestCase):
    """11: held-out wording overclaimed."""

    def test_no_never_trained_on_claims_remain(self):
        for path in [HERE / "images" / "train" / "train.py", HERE / "valcairn_runner" / "export.py", HERE / "README.md"]:
            self.assertNotIn("never trained on", path.read_text(encoding="utf-8").lower(), path.name)


if __name__ == "__main__":
    unittest.main()
