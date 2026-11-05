"""Regressions for the independent PR16 review (comment 6638291593) that exercise the train handler, and the
training-image default. Each review case fails on a6e3513 and passes after. The review's findings on the shared
example rules live in test_examples.py; the export handler's in test_export_review.py. Only temporary folders,
in-memory fakes and the real stdlib helpers are used: no Docker, model, GPU or Ollama."""

import json
import os
import re
import tempfile
import unittest
from pathlib import Path

from fixtures_runner import TRAIN_JOB, Box, Ctx, Inputs, serve_data
from valcairn_runner import training
from valcairn_runner.runner import Settings
from valcairn_runner.sandbox import Cancelled
from valcairn_runner.training import JobFailure

HERE = Path(__file__).resolve().parent.parent


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
                raise OSError("connection reset https://ingest.example/x?sig=SECRET")
        with self.assertRaises(JobFailure) as e:
            training.download("https://ingest.example/x?sig=SECRET", dest, "0" * 64, opener=lambda url, *a, **k: (None, Broken()))
        self.assertEqual((e.exception.category, e.exception.retryable), ("dataset_error", True))
        self.assertNotIn("SECRET", str(e.exception), "the signed link is not in the reported message")
        self.assertEqual(list(dest.parent.iterdir()), [])

    def test_a_cancelled_training_attempt_keeps_no_dataset_bytes(self):
        home = Path(tempfile.mkdtemp())
        serve_data(self)
        ctx = Ctx(home, TRAIN_JOB, api=Inputs(), sandbox=Box(lambda step, c: (_ for _ in ()).throw(Cancelled()) if step.command[-1] == "train.py" else None))
        with self.assertRaises(Cancelled):
            training.train(ctx)
        self.assertFalse((home / "jobs" / TRAIN_JOB / "attempt-1").exists())


class TrainingImage(unittest.TestCase):
    """12: the runner still defaulted to valcairn-train:0.1, a cached image without the repaired shared rules."""

    def test_the_default_image_follows_the_runner_release_and_the_docs_build_that_tag(self):
        tag = Settings().train_image
        self.assertEqual(tag, "valcairn-train:0.4.0")
        readme = (HERE / "README.md").read_text(encoding="utf-8")
        self.assertIn(f"docker build -t {tag} images/train", readme, "the build example makes the tag the runner uses")
        self.assertIn(f"| `VALCAIRN_TRAIN_IMAGE` | `{tag}` |", readme, "the configuration table shows the same default")
        self.assertNotIn("valcairn-train:0.1 images/train", readme, "no build example names the old tag")
        main = (HERE / "valcairn_runner" / "__main__.py").read_text(encoding="utf-8")
        self.assertIn('os.environ.get("VALCAIRN_TRAIN_IMAGE", Settings.train_image)', main, "the override stays; the default is its only fallback")
        for source in (HERE / "valcairn_runner").glob("*.py"):
            tags = re.findall(r"valcairn-train:[0-9.]+", source.read_text(encoding="utf-8"))
            self.assertEqual(tags, [tag] if source.name == "runner.py" else [], f"{source.name}: one default and no other tag to fall back to")


if __name__ == "__main__":
    unittest.main()
