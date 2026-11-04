import threading
import unittest

from valcairn_runner.api import Api, ApiError, LeaseLost, check_base_url
from valcairn_runner.jobs import JobFailure
from valcairn_runner.machine import local_models, parse_nvidia_smi
from valcairn_runner.runner import Settings, run_job
from valcairn_runner import jobs as job_handlers
from valcairn_runner.sandbox import Cancelled, Step, docker_args

KEY = "vrk_" + "a" * 43


class FakeApi:
    """Records calls; scripted replies for touch/events/finish."""

    def __init__(self, cancel_after_touch=False, lose=False, fail_events_once=False):
        self.calls, self.events_sent = [], []
        self.cancel_after_touch, self.lose, self.fail_events_once = cancel_after_touch, lose, fail_events_once

    def _job(self):
        return {"id": "j1", "status": "running", "cancelRequested": self.cancel_after_touch}

    def touch(self, job_id, token):
        self.calls.append("touch")
        if self.lose:
            raise LeaseLost("gone")
        return self._job()

    def events(self, job_id, token, events):
        self.calls.append("events")
        if self.fail_events_once:
            self.fail_events_once = False
            raise OSError("network down")
        if self.lose:
            raise LeaseLost("gone")
        self.events_sent.extend(events)
        return {"added": len(events), "job": self._job()}

    def finish(self, job_id, token, **outcome):
        self.calls.append(("finish", outcome))
        return {"status": "cancelled" if outcome.get("failure") == "cancelled" else ("succeeded" if outcome["outcome"] == "succeeded" else "failed")}


class FakeSandbox:
    def __init__(self, lines=(), code=0, block=False):
        self.lines, self.code, self.block, self.stopped = list(lines), code, block, threading.Event()

    def stop(self):
        self.stopped.set()

    def run(self, step, on_line, cancelled):
        for line in self.lines:
            on_line(line)
        if self.block:
            self.stopped.wait(5)
            raise Cancelled()
        return self.code


CAPS = {"gpus": [{"name": "GPU", "memoryMb": 24000}], "ollama": {"reachable": True}, "sandbox": {"available": True, "gpu": True}}
FAST = Settings(touch_seconds=0.05)


def job(kind="probe"):
    return {"id": "j1", "kind": kind, "attempt": 1, "leaseToken": "t", "spec": {"checks": ["gpu"]}}


class MachineTests(unittest.TestCase):
    def test_parse_nvidia_smi(self):
        self.assertEqual(parse_nvidia_smi("NVIDIA RTX, 24463, 617.14\nbad line\n"), [{"name": "NVIDIA RTX", "memoryMb": 24463, "driver": "617.14"}])
        self.assertEqual(parse_nvidia_smi(None), [])

    def test_cloud_models_are_not_reported_as_local(self):
        tags = {"models": [{"name": "local:1b", "digest": "d", "size": 1}, {"name": "remote:cloud", "remote_host": "https://ollama.com"}]}
        self.assertEqual([m["name"] for m in local_models(tags)], ["local:1b"])

    def test_key_only_travels_over_https_or_loopback(self):
        self.assertEqual(check_base_url("https://valcairn.example/"), "https://valcairn.example")
        self.assertEqual(check_base_url("http://127.0.0.1:3000"), "http://127.0.0.1:3000")
        for bad in ["http://valcairn.example", "ftp://x", "https://valcairn.example/api", "https://x?y=1", "valcairn.example"]:
            with self.assertRaises(ValueError, msg=bad):
                check_base_url(bad)
        with self.assertRaises(ValueError):
            Api("https://valcairn.example", "not-a-key")


class SandboxTests(unittest.TestCase):
    def test_container_is_locked_down(self):
        args = docker_args(Step(image="img", command=["run"], gpus=True, inputs={"/data": "/in"}, output="/o"), "n1")
        joined = " ".join(args)
        for flag in ["--network none", "--read-only", "--cap-drop ALL", "--security-opt no-new-privileges", "--pids-limit", "--memory", "--user 65534:65534", "--gpus all"]:
            self.assertIn(flag, joined)
        self.assertIn("type=bind,source=/data,target=/in,readonly", joined)
        self.assertEqual(args[-2:], ["img", "run"])
        self.assertNotIn("--gpus", docker_args(Step(image="img", command=["x"]), "n2"))


class RunJobTests(unittest.TestCase):
    def test_probe_succeeds_and_reports_events_in_order(self):
        api = FakeApi()
        status = run_job(api, job(), FakeSandbox(lines=["GPU A, 24000, 1.0"]), FAST, CAPS)
        self.assertEqual(status, "succeeded")
        finish = [c for c in api.calls if isinstance(c, tuple)][0][1]
        self.assertEqual(finish["result"]["sandboxGpus"][0]["memoryMb"], 24000)
        self.assertEqual([e["seq"] for e in api.events_sent], list(range(len(api.events_sent))))

    def test_cancel_requested_stops_the_sandbox_and_reports_cancelled(self):
        api, box = FakeApi(cancel_after_touch=True), FakeSandbox(block=True)
        self.assertEqual(run_job(api, job(), box, FAST, CAPS), "cancelled")
        self.assertTrue(box.stopped.is_set())

    def test_lost_lease_stops_work_and_reports_nothing(self):
        api, box = FakeApi(lose=True), FakeSandbox(block=True)
        self.assertEqual(run_job(api, job(), box, FAST, CAPS), "lost")
        self.assertFalse(any(isinstance(c, tuple) for c in api.calls), "no finish after losing the lease")

    def test_failures_report_a_category_only(self):
        api = FakeApi()
        run_job(api, job("shell"), FakeSandbox(), FAST, CAPS)
        self.assertEqual(api.calls[-1][1], {"outcome": "failed", "failure": "unsupported"})
        api = FakeApi()
        run_job(api, job(), FakeSandbox(code=3), FAST, CAPS)
        self.assertEqual(api.calls[-1][1]["failure"], "sandbox_error")
        api = FakeApi()
        run_job(api, job(), FakeSandbox(), FAST, {**CAPS, "sandbox": {"available": False}})
        self.assertEqual(api.calls[-1][1]["failure"], "sandbox_unavailable")

    def test_handler_crash_is_a_runtime_error(self):
        def boom(ctx):
            raise KeyError("secret row 42")
        job_handlers.HANDLERS["boom"] = boom
        try:
            api = FakeApi()
            run_job(api, job("boom"), FakeSandbox(), FAST, CAPS)
            self.assertEqual(api.calls[-1][1], {"outcome": "failed", "failure": "runtime_error"})
        finally:
            del job_handlers.HANDLERS["boom"]

    def test_a_failed_event_batch_is_resent_with_the_same_sequence_numbers(self):
        api = FakeApi(fail_events_once=True)
        run_job(api, job(), FakeSandbox(lines=["GPU A, 24000, 1.0"]), FAST, CAPS)
        seqs = [e["seq"] for e in api.events_sent]
        self.assertEqual(seqs, sorted(set(seqs)))
        self.assertEqual(seqs[0], 0)

    def test_retryable_failures_say_so(self):
        def oom(ctx):
            raise JobFailure("out_of_memory", retryable=True)
        job_handlers.HANDLERS["oom"] = oom
        try:
            api = FakeApi()
            run_job(api, job("oom"), FakeSandbox(), FAST, CAPS)
            self.assertEqual(api.calls[-1][1], {"outcome": "failed", "failure": "out_of_memory", "retryable": True})
        finally:
            del job_handlers.HANDLERS["oom"]


class ApiErrorTests(unittest.TestCase):
    def test_lease_lost_and_auth_are_distinct(self):
        import io
        import urllib.error
        from valcairn_runner.api import AuthError

        def opener(code, body):
            def _open(req, timeout):
                raise urllib.error.HTTPError(req.full_url, code, "x", {}, io.BytesIO(body))
            return _open
        with self.assertRaises(LeaseLost):
            Api("https://v.example", KEY, opener=opener(409, b'{"code":"lease_lost"}')).touch("j", "t")
        with self.assertRaises(AuthError):
            Api("https://v.example", KEY, opener=opener(401, b"{}")).lease()
        with self.assertRaises(ApiError):
            Api("https://v.example", KEY, opener=opener(500, b"not json")).lease()


class SandboxLifetimeTests(unittest.TestCase):
    """The container never outlives its step, and the runner never waits forever on it."""

    class Proc:
        def __init__(self, lines, hang=False):
            self.stdout = iter(lines)
            self.hang, self.killed, self.waits = hang, False, 0

        def wait(self, timeout=None):
            self.waits += 1
            if self.hang and not self.killed:
                import subprocess
                raise subprocess.TimeoutExpired("docker", timeout)
            return 0

        def kill(self):
            self.killed = True

    def make(self, proc):
        from valcairn_runner.sandbox import Sandbox
        kills = []
        from types import SimpleNamespace

        def docker(args, **k):
            kills.append(args)
            # After a kill, Docker reports the container gone.
            return SimpleNamespace(returncode=1 if args[1] == "inspect" else 0, stdout="", stderr="No such object")
        box = Sandbox(popen=lambda *a, **k: proc, run=docker, sleep=lambda s: None)
        return box, kills

    def test_a_failing_line_handler_stops_the_container(self):
        proc = self.Proc(["one", "two"])
        box, kills = self.make(proc)

        def bad(line):
            raise RuntimeError("handler bug")
        with self.assertRaises(RuntimeError):
            box.run(Step(image="img", command=["x"]), bad, threading.Event())
        self.assertTrue(kills and kills[0][:2] == ["docker", "kill"], "docker kill was called")

    def test_a_docker_client_that_will_not_exit_is_killed(self):
        proc = self.Proc([], hang=True)
        box, kills = self.make(proc)
        self.assertNotEqual(box.run(Step(image="img", command=["x"]), lambda line: None, threading.Event()), 0, "a killed client is never success")
        self.assertTrue(proc.killed)
        self.assertTrue(kills)


class EventOrderTests(unittest.TestCase):
    def test_a_refused_batch_is_dropped_not_resent_forever(self):
        class Refusing(FakeApi):
            def events(self, job_id, token, events):
                self.calls.append("events")
                raise ApiError(400, {"errors": {"events": "bad"}})
        api = Refusing()
        run_job(api, job(), FakeSandbox(lines=["GPU A, 24000, 1.0"]), FAST, CAPS)
        self.assertLessEqual(api.calls.count("events"), 3)

    def test_concurrent_flushes_keep_sequence_order(self):
        from valcairn_runner.runner import JobContext
        gate = threading.Event()

        class Slow(FakeApi):
            def events(self, job_id, token, events):
                gate.wait(2)
                return super().events(job_id, token, events)
        api = Slow()
        ctx = JobContext(api, job(), FakeSandbox(), FAST, CAPS)
        for i in range(60):
            ctx._pending.append({"seq": i, "kind": "log", "data": {"level": "info", "message": str(i)}})
        first = threading.Thread(target=ctx.flush)
        first.start()
        ctx.flush()  # skipped while the first is sending
        gate.set()
        first.join()
        ctx.flush()
        self.assertEqual([e["seq"] for e in api.events_sent], list(range(60)))

if __name__ == "__main__":
    unittest.main()
