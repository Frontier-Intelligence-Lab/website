import hashlib
import json
import unittest

from fixtures_runner import EXPORT_JOB, SYSTEM, Box, Ctx, Ollama, export_spec, trained
from valcairn_runner import export as exporter
from valcairn_runner.sandbox import Cancelled
from valcairn_runner.training import JobFailure

ORIGINAL_LOAD_TEST = exporter.load_test


def run_export(test, home, result, job_id=EXPORT_JOB, attempt=1, sandbox=None, spec=None):
    ctx = Ctx(home, job_id, attempt, spec=spec or export_spec(result), sandbox=sandbox, kind="export")
    return ctx, exporter.export(ctx)


class ExportTests(unittest.TestCase):
    def setUp(self):
        self.home, self.result = trained(self)
        self.ollama = Ollama().install(self)

    def test_exports_tuned_and_base_alike_and_publishes_only_after_the_load_test(self):
        ctx, result = run_export(self, self.home, self.result)
        merge, tuned, base = ctx.sandbox.steps
        self.assertTrue(all(s.network == "none" for s in ctx.sandbox.steps), "no export step has network access")
        self.assertEqual(tuned.entrypoint, "", "the converter runs directly, not through the image's launcher")
        self.assertIn("q8_0", tuned.command)
        self.assertIn("q8_0", base.command, "base and tuned use the same quantization")
        final, provisional = f"valcairn-{EXPORT_JOB}-a1", f"valcairn-p-{EXPORT_JOB}-a1"
        base_name = f"valcairn-base-{hashlib.sha256(b'gguf-base').hexdigest()[:16]}"
        kinds = [c[0] + ":" + c[-1] for c in self.ollama.calls if c[0] != "has"]
        self.assertEqual(kinds, [f"create:{provisional}", f"create:{base_name}", f"load:{provisional}", f"load:{base_name}", f"copy:{final}", f"delete:{provisional}"],
                         "the final name appears only after both load tests")
        self.assertEqual(set(self.ollama.models), {final, base_name})
        self.assertIn(f'SYSTEM """{SYSTEM}"""', self.ollama.models[final], "the training system prompt becomes the model's default")
        self.assertEqual(result["ollamaModel"], final)
        self.assertEqual(result["gguf"]["sha256"], hashlib.sha256(b"gguf-tuned").hexdigest())
        self.assertEqual(result["baseGgufSha256"], hashlib.sha256(b"gguf-base").hexdigest())
        self.assertEqual(result["trainingManifestSha256"], self.result["trainingManifestSha256"])
        split = json.loads((self.home / "jobs" / self.result["adapter"]["location"].split("/")[1] / "attempt-1" / "out" / "split.json").read_text())
        self.assertTrue(result["samples"], "held-out prompts only, from the training run's split")
        trained_prompts = {f"question {i}" for i in range(30)} - {s["prompt"] for s in result["samples"]}
        self.assertEqual(len(trained_prompts), 30 - len(result["samples"]))
        self.assertFalse(set(split["train"]) & set(split["heldOut"]))
        folder = self.home / result["location"]
        manifest = json.loads((folder / "manifest.json").read_text())
        self.assertEqual(manifest["adapter"]["sha256"], hashlib.sha256(b"adapter").hexdigest())
        self.assertTrue((folder / "MODEL_CARD.md").exists() and (folder / "LICENSE").exists())
        self.assertFalse((self.home / "jobs" / EXPORT_JOB / "attempt-1" / "merged").exists(), "merged full weights are not kept")
        # The base GGUF is made once per runner for the same inputs, converter and quantization.
        ctx2, _ = run_export(self, self.home, self.result, job_id=EXPORT_JOB[:-1] + "c")
        self.assertEqual(len(ctx2.sandbox.steps), 2)

    def test_refuses_an_adapter_that_is_missing_changed_or_outside_the_runner_home(self):
        good = export_spec(self.result)
        cases = {
            "changed": {**good["source"], "adapterSha256": "0" * 64},
            "missing": {**good["source"], "adapterLocation": "jobs/none/out/adapter"},
            "outside": {**good["source"], "adapterLocation": "../../../etc"},
            "no manifest hash": {k: v for k, v in good["source"].items() if k != "trainingManifestSha256"},
        }
        for why, source in cases.items():
            with self.assertRaises(JobFailure, msg=why) as e:
                run_export(self, self.home, self.result, spec={**good, "source": source})
            self.assertEqual(e.exception.category, "model_unavailable", why)

    def test_a_failed_conversion_leaves_nothing_a_later_export_would_reuse(self):
        def fail_convert(step, cancelled):
            if "/app/convert_hf_to_gguf.py" in step.command:
                (__import__("pathlib").Path(step.output) / step.command[-1].split("/")[-1]).write_bytes(b"half")
                return 1
            return None
        with self.assertRaises(JobFailure):
            run_export(self, self.home, self.result, sandbox=Box(fail_convert))
        self.assertFalse(list(self.home.rglob("*.gguf")), "no partial GGUF is kept under its final name")
        self.assertFalse(list(self.home.rglob("*.part")))
        self.assertFalse((self.home / "jobs" / EXPORT_JOB).exists() and any((self.home / "jobs" / EXPORT_JOB).rglob("*")), "the failed attempt keeps nothing")

    def test_ollama_not_answering_is_a_clear_failure(self):
        def down(*args, **kwargs):
            raise OSError("connection refused")
        real = exporter.ollama_chat
        exporter.ollama_chat = down
        try:
            with self.assertRaises(JobFailure) as e:
                ORIGINAL_LOAD_TEST("http://127.0.0.1:11434", "m", [[{"role": "user", "content": "q"}]])
            self.assertEqual(e.exception.category, "runtime_error")
        finally:
            exporter.ollama_chat = real

    def test_a_cancel_during_the_load_test_publishes_nothing(self):
        real = self.ollama.load_test

        def cancel_after_tuned(host, model, conversations, cancelled=None, opener=None):
            out = real(host, model, conversations, cancelled)
            cancelled.set()
            return out
        exporter.load_test = cancel_after_tuned
        with self.assertRaises(Cancelled):
            run_export(self, self.home, self.result)
        self.assertNotIn(f"valcairn-{EXPORT_JOB}-a1", self.ollama.models)
        self.assertNotIn(f"valcairn-p-{EXPORT_JOB}-a1", self.ollama.models, "the provisional model is removed")


if __name__ == "__main__":
    unittest.main()
