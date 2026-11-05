"""Regressions for the final PR16 export repairs: cooperative cancellation of an in-flight load-test request at any
point of the reply, malformed Ollama replies, bounded `ollama create` cleanup, names that are never replaced, no
publication once a cancel is known, lineage folders that are never links, and speeds that are measured or absent.

Only temporary folders, in-memory fakes and synthetic HTTP servers on 127.0.0.1 are used. The synthetic servers
answer with canned bytes; no model, Docker, GPU or real Ollama is involved, and nothing installed is touched."""

import hashlib
import json
import shutil
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path

from fixtures_export import EXPORT_JOB, Ollama, export_spec
from fixtures_runner import TRAIN_JOB, Ctx, trained
from synthetic_http import dripping, loopback, paused, synthetic_daemon
from valcairn_runner import export as exporter
from valcairn_runner.sandbox import Cancelled
from valcairn_runner.training import JobFailure

TURNS = [{"role": "user", "content": "synthetic request"}]
GOOD = {"message": {"role": "assistant", "content": " synthetic answer "}, "eval_count": 10, "eval_duration": 2_000_000_000}
PAYLOAD = json.dumps(GOOD).encode()
HEAD = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n" % len(PAYLOAD)
# The phases a reply can be in when the cancel or the deadline arrives.
REPLY_PHASES = {
    "waiting-headers": paused(b"", HEAD + PAYLOAD),
    "partial-headers": paused(HEAD[:30], HEAD[30:] + PAYLOAD),
    "partial-body": paused(HEAD + PAYLOAD[:1], PAYLOAD[1:]),
    "dripping-headers": dripping(b"HTTP/1.1 200 OK\r\nX-Filler: "),
    "dripping-body": dripping(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100000\r\n\r\n"),
}
BASE_NAME = f"valcairn-base-{hashlib.sha256(b'gguf-base').hexdigest()[:16]}"


class InFlightCancellation(unittest.TestCase):
    """The coordination probes: a cancel while the daemon was still answering left the caller blocked, and the answer
    that came later was accepted as a successful load test. The first repair only covered the wait before the first
    byte; a reply arrives in arbitrary packets, so the wait inside the status line, headers and body counts too. The
    second repair checked the flags only when a wait timed out; a reply that keeps trickling bytes never let a wait
    time out, so the flags must be looked at before every wait and every read."""

    def held_reply(self, behave):
        return synthetic_daemon(self, behave)

    def test_a_cancel_at_any_point_of_the_reply_ends_the_wait_and_closes_the_connection(self):
        for name, phase in REPLY_PHASES.items():
            with self.subTest(phase=name):
                url, requests, entered, release, gone = self.held_reply(phase)
                cancelled, outcome = threading.Event(), []

                def run():
                    try:
                        outcome.append(exporter.load_test(url, "m", [TURNS, TURNS], cancelled))
                    except BaseException as error:  # noqa: BLE001 - the kind of exception is the point
                        outcome.append(error)
                caller = threading.Thread(target=run, daemon=True)
                caller.start()
                self.assertTrue(entered.wait(3), "the synthetic request did not start")
                started = time.monotonic()
                cancelled.set()
                caller.join(2)
                self.assertFalse(caller.is_alive(), "the caller is still blocked after the cancel")
                self.assertLess(time.monotonic() - started, 1.5)
                self.assertIsInstance(outcome[0], Cancelled, outcome)
                self.assertTrue(gone.wait(2), "the daemon did not see the client go before it had an answer")
                release.set()
                time.sleep(0.3)
                self.assertEqual(len(requests), 1, "no further conversation was sent after the cancel")

    def test_the_deadline_holds_at_any_point_of_the_reply(self):
        for name, phase in REPLY_PHASES.items():
            with self.subTest(phase=name):
                url, requests, entered, release, gone = self.held_reply(phase)
                started = time.monotonic()
                with self.assertRaises(JobFailure) as e:
                    exporter.ollama_chat(url, "m", TURNS, None, timeout=0.5)
                self.assertEqual(e.exception.category, "timeout")
                self.assertLess(time.monotonic() - started, 1.5)
                self.assertTrue(gone.wait(2), "the daemon did not see the client go")

    def test_an_answer_that_arrives_after_the_cancel_was_seen_is_not_used(self):
        cancelled = threading.Event()

        def answer_then(handler):
            cancelled.set()
            return 200, json.dumps(GOOD).encode(), {}
        url, requests = loopback(self, answer_then)
        with self.assertRaises(Cancelled):
            exporter.load_test(url, "m", [TURNS, TURNS], cancelled)
        self.assertEqual(len(requests), 1)

    def test_a_reply_delivered_in_many_small_packets_is_still_read_whole(self):
        def dribble(handler):
            for i in range(0, len(HEAD) + len(PAYLOAD), 7):
                handler.wfile.write((HEAD + PAYLOAD)[i:i + 7])
                time.sleep(0.005)
            return None
        url, _ = loopback(self, dribble)
        self.assertEqual(exporter.load_test(url, "m", [TURNS], threading.Event())["answers"], ["synthetic answer"])


class MalformedReplies(unittest.TestCase):
    """A reply of another shape was an AttributeError (not a dict) or a trusted bool, float or absurd counter."""

    def setUp(self):
        self.reply = (200, json.dumps(GOOD).encode(), {})
        self.url, self.requests = loopback(self, lambda handler: self.reply)

    def test_a_good_reply_gives_the_answer_and_the_speed_from_the_counters(self):
        result = exporter.load_test(self.url, "m", [TURNS], None)
        self.assertEqual(result, {"model": "m", "tokensPerSec": 5.0, "answers": ["synthetic answer"]})
        self.reply = (200, json.dumps({"message": {"content": "no counters"}}).encode(), {})
        self.assertEqual(exporter.load_test(self.url, "m", [TURNS], None)["tokensPerSec"], None, "a reply without counters has no speed")

    def test_replies_of_another_shape_are_a_clear_failure_without_the_body(self):
        bodies = [b"[1, 2]", b'"text"', b"null", b"not json {", b'{"message": "unexpected-marker"}', b'{"message": {"content": 5}}',
                  b'{"message": {"content": "x"}, "eval_count": true}', b'{"message": {"content": "x"}, "eval_count": 1.5}',
                  b'{"message": {"content": "x"}, "eval_duration": -1}', b'{"message": {"content": "x"}, "eval_duration": 1e400}',
                  b'{"message": {"content": "x"}, "eval_count": NaN}', b'{"message": {"content": "x"}, "eval_duration": ' + b"9" * 80 + b"}",
                  b'{"message": {"content": "x"}, "eval_count": null}']
        for body in bodies:
            self.reply = (200, body, {})
            with self.assertRaises(JobFailure, msg=body) as e:
                exporter.load_test(self.url, "m", [TURNS], None)
            self.assertEqual(e.exception.category, "runtime_error", body)
            self.assertNotIn("unexpected-marker", str(e.exception))
        self.reply = (500, b'{"error": "unexpected-marker"}', {})
        with self.assertRaises(JobFailure) as e:
            exporter.load_test(self.url, "m", [TURNS], None)
        self.assertEqual(e.exception.category, "runtime_error")
        self.assertNotIn("unexpected-marker", str(e.exception))
        self.reply = (200, b'{"message": {"content": "' + b"x" * exporter.MAX_REPLY_BYTES + b'"}}', {})
        with self.assertRaises(JobFailure) as e:
            exporter.load_test(self.url, "m", [TURNS], None)
        self.assertEqual(e.exception.category, "runtime_error", "a reply beyond the size limit is not read whole")

    def test_a_redirect_is_never_followed(self):
        self.reply = (302, b"", {"Location": f"{self.url}/elsewhere"})
        with self.assertRaises(JobFailure) as e:
            exporter.load_test(self.url, "m", [TURNS], None)
        self.assertEqual(e.exception.category, "runtime_error")
        self.assertEqual(self.requests, [("POST", "/api/chat")], "the redirect target was never requested")


class NamesAndCleanup(unittest.TestCase):
    """A preexisting provisional name could be created over; an interrupted create could leave a model under this
    attempt's name; a killed `ollama create` client was waited for without bound; a cancel seen during the final
    name's existence check was still followed by the copy."""

    def test_a_preexisting_provisional_name_is_refused_before_any_work_and_left_alone(self):
        home, result = trained(self)
        provisional = f"valcairn-p-{EXPORT_JOB}-a1"
        ollama = Ollama(existing=[provisional]).install(self)
        ctx = Ctx(home, EXPORT_JOB, spec=export_spec(result), kind="export")
        with self.assertRaises(JobFailure) as e:
            exporter.export(ctx)
        self.assertEqual(e.exception.category, "runtime_error")
        self.assertEqual(ollama.models, {provisional: "user-made"})
        self.assertEqual([c for c in ollama.calls if c[0] != "has"], [], "nothing was created, loaded, copied or deleted")
        self.assertEqual(ctx.sandbox.steps, [], "refused before any container step")

    def test_a_create_interrupted_by_a_cancel_removes_only_this_attempts_provisional_model(self):
        home, result = trained(self)
        ollama = Ollama(existing=["someone-elses-model"]).install(self)

        def interrupted(name, folder, host, cancelled):
            if name.startswith("valcairn-p-"):
                cancelled.set()
                ollama.models[name] = "finished by the daemon after its client was killed"
                raise Cancelled()
            ollama.create(name, folder, host, cancelled)
        exporter.ollama_create = interrupted
        with self.assertRaises(Cancelled):
            exporter.export(Ctx(home, EXPORT_JOB, spec=export_spec(result), kind="export"))
        self.assertEqual(ollama.models, {"someone-elses-model": "user-made"})
        self.assertEqual([c[-1] for c in ollama.calls if c[0] == "delete"], [f"valcairn-p-{EXPORT_JOB}-a1"])

    def test_a_cancel_seen_during_the_final_existence_check_publishes_nothing(self):
        """Root's probe: the cancel check sat before the blocking final-name lookup, so a cancel seen during that
        lookup was followed by the copy, and the export returned success with the final model created."""
        home, result = trained(self)
        ollama = Ollama().install(self)
        ctx = Ctx(home, EXPORT_JOB, spec=export_spec(result), kind="export")
        final, lookups, real = f"valcairn-{EXPORT_JOB}-a1", [], exporter.ollama_has

        def has(host, name, opener=None):
            answer = real(host, name, opener)
            if name == final:
                lookups.append(name)
                if len(lookups) == 2:
                    ctx.cancelled.set()  # the cancel arrives while the final existence query is in flight
            return answer
        exporter.ollama_has = has
        with self.assertRaises(Cancelled):
            exporter.export(ctx)
        self.assertEqual(len(lookups), 2)
        self.assertEqual([c for c in ollama.calls if c[0] == "copy"], [], "no copy once the cancel is known")
        self.assertEqual(set(ollama.models), {BASE_NAME}, "no final model, no provisional model; the shared base stays")
        self.assertFalse(list((home / "jobs" / EXPORT_JOB).rglob("*")) if (home / "jobs" / EXPORT_JOB).exists() else [], "no artifact is kept")

    def test_a_cancel_seen_after_the_copy_was_dispatched_ends_the_attempt_and_removes_what_it_made(self):
        """A dispatched copy cannot be undone atomically; what can be promised is that the attempt writes nothing
        more and removes the model it copied, best effort."""
        home, result = trained(self)
        ollama = Ollama().install(self)
        ctx = Ctx(home, EXPORT_JOB, spec=export_spec(result), kind="export")
        real = exporter.ollama_copy

        def copy_then_cancel(host, source, destination, opener=None):
            real(host, source, destination, opener)  # the copy went through
            ctx.cancelled.set()
        exporter.ollama_copy = copy_then_cancel
        with self.assertRaises(Cancelled):
            exporter.export(ctx)
        final, provisional = f"valcairn-{EXPORT_JOB}-a1", f"valcairn-p-{EXPORT_JOB}-a1"
        self.assertEqual([c[-1] for c in ollama.calls if c[0] == "copy"], [final], "the copy had been dispatched")
        self.assertEqual([c[-1] for c in ollama.calls if c[0] == "delete"], [provisional, final], "only this attempt's names are removed")
        self.assertEqual(set(ollama.models), {BASE_NAME})
        self.assertEqual(list(home.rglob("MODEL_CARD.md")), [], "no export manifest or model card is written")
        self.assertFalse((home / "jobs" / EXPORT_JOB / "attempt-1").exists(), "the working files are removed")

    def test_a_killed_create_client_is_waited_for_a_bounded_time_and_the_outcome_stands(self):
        waited = []

        class Proc:
            returncode = None

            def poll(self):
                return None

            def kill(self):
                pass

            def wait(self, timeout=None):
                waited.append(timeout)
                raise subprocess.TimeoutExpired("ollama", timeout)
        cancelled = threading.Event()
        threading.Timer(0.1, cancelled.set).start()
        with self.assertRaises(Cancelled):
            exporter.ollama_create("m", Path(tempfile.mkdtemp()), "http://127.0.0.1:11434", cancelled, popen=lambda *a, **k: Proc())
        with self.assertRaises(JobFailure) as e:
            exporter.ollama_create("m", Path(tempfile.mkdtemp()), "http://127.0.0.1:11434", threading.Event(), popen=lambda *a, **k: Proc(), seconds=0)
        self.assertEqual(e.exception.category, "timeout")
        self.assertEqual(waited, [exporter.STOP_SECONDS] * 2)


class SpeedMetrics(unittest.TestCase):
    """Root's finding: an unknown speed (a reply without counters) was emitted as a measured 0 tokens per second."""

    def test_an_unknown_speed_is_not_reported_and_a_measured_zero_is(self):
        home, result = trained(self)
        ollama = Ollama().install(self)
        speeds = {f"valcairn-p-{EXPORT_JOB}-a1": None}  # the tuned model's reply had no counters; the base measured zero
        real = ollama.load_test

        def load_test(host, model, conversations, cancelled=None, opener=None):
            out = real(host, model, conversations, cancelled)
            out["tokensPerSec"] = speeds.get(model, 0.0)
            return out
        exporter.load_test = load_test
        ctx = Ctx(home, EXPORT_JOB, spec=export_spec(result), kind="export")
        out = exporter.export(ctx)
        metrics = {d["name"]: d["value"] for kind, d in ctx.events if kind == "metric"}
        self.assertNotIn("tuned_tokens_per_sec", metrics, "no counters means no measurement, not a zero")
        self.assertEqual(metrics["base_tokens_per_sec"], 0.0, "a measured zero is reported as zero")
        self.assertEqual((out["loadTest"]["tuned"]["tokensPerSec"], out["loadTest"]["base"]["tokensPerSec"]), (None, 0.0))


class LineageGuards(unittest.TestCase):
    """Folders that export hashes and mounts were not checked against links; a manifest or split of another shape
    was a KeyError or TypeError rather than a refusal."""

    def setUp(self):
        self.home, self.result = trained(self)
        self.ollama = Ollama().install(self)
        self.out = self.home / "jobs" / TRAIN_JOB / "attempt-1" / "out"

    def refused(self, spec=None):
        ctx = Ctx(self.home, EXPORT_JOB, spec=spec or export_spec(self.result), kind="export")
        with self.assertRaises(JobFailure) as e:
            exporter.export(ctx)
        self.assertEqual(ctx.sandbox.steps, [], "refused before any container step")
        self.assertEqual([c for c in self.ollama.calls if c[0] in ("create", "load", "copy")], [])
        return e.exception

    def test_a_linked_adapter_data_or_base_model_folder_is_refused_before_it_is_mounted(self):
        outside = Path(tempfile.mkdtemp())
        folders = [self.out / "adapter", self.out.parent / "data", next((self.home / "models").rglob("config.json")).parent]
        for folder in folders:
            target = outside / folder.name
            shutil.move(folder, target)
            try:
                folder.symlink_to(target, target_is_directory=True)
            except OSError:
                shutil.move(target, folder)
                self.skipTest("this machine cannot create symlinks")
            try:
                self.assertIn("link", str(self.refused()), folder.name)  # identical bytes behind the link do not help
            finally:
                folder.unlink()
                shutil.move(target, folder)
        exporter.export(Ctx(self.home, EXPORT_JOB, spec=export_spec(self.result), kind="export"))  # the real folders still export

    def test_a_manifest_of_another_shape_is_a_clear_refusal(self):
        for text in [json.dumps({"schema": "valcairn.training/9", "trainJobId": TRAIN_JOB}), "[]", json.dumps({"schema": "valcairn.training/1", "trainJobId": TRAIN_JOB}), "{not json"]:
            (self.out / "manifest.json").write_text(text, encoding="utf-8")
            spec = export_spec(self.result)
            spec["source"]["trainingManifestSha256"] = hashlib.sha256(text.encode()).hexdigest()
            self.assertEqual(self.refused(spec).category, "model_unavailable", text)

    def test_a_split_of_another_shape_is_a_clear_refusal(self):
        for text in ['{"train": "x", "heldOut": [1]}', "[]", '{"heldOut": []}']:
            (self.out / "split.json").write_text(text, encoding="utf-8")
            with self.assertRaises(JobFailure, msg=text) as e:
                exporter.held_out(self.out.parent)
            self.assertEqual(e.exception.category, "model_unavailable")
        (self.out / "split.json").write_text('{"train": [[1]], "heldOut": [[2], 3]}', encoding="utf-8")
        self.assertEqual(exporter.held_out(self.out.parent)[0], [], "entries that are not hashes hold nothing out")


if __name__ == "__main__":
    unittest.main()
