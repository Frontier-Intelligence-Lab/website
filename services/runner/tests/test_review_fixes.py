"""Regressions for the independent PR14 review (comment 6637438951). Each test fails on 308bbee and passes after."""

import http.server
import subprocess
import threading
import unittest
from types import SimpleNamespace

from valcairn_runner import jobs as job_handlers
from valcairn_runner.api import Api, ApiError, AuthError
from valcairn_runner.machine import is_remote, local_models
from valcairn_runner.runner import RunnerHalted, Settings, run_job, serve
from valcairn_runner.sandbox import Cancelled, ContainerNotStopped, Limits, Sandbox, Step

KEY = "vrk_" + "s" * 43  # synthetic placeholder, never a real key
FAST = Settings(touch_seconds=0.02)
CAPS = {"gpus": [], "ollama": {"reachable": False}, "sandbox": {"available": True, "gpu": False}}


def job(kind="probe"):
    return {"id": "j1", "kind": kind, "attempt": 1, "leaseToken": "t", "spec": {}}


class Docker:
    """A fake `docker` CLI: `kill` and `inspect` answer the way a real daemon would for the given behaviour."""

    def __init__(self, kill_works=True):
        self.kill_works, self.calls, self.running = kill_works, [], True

    def __call__(self, args, **_):
        self.calls.append(args[1])
        if args[1] == "kill":
            if self.kill_works:
                self.running = False
                return SimpleNamespace(returncode=0, stdout="", stderr="")
            return SimpleNamespace(returncode=1, stdout="", stderr="Error response from daemon: cannot kill container")
        if args[1] == "inspect":
            if not self.running:
                return SimpleNamespace(returncode=1, stdout="", stderr="Error: No such object: valcairn-x")
            return SimpleNamespace(returncode=0, stdout="true\n", stderr="")
        return SimpleNamespace(returncode=0, stdout="", stderr="")


class SilentProc:
    """A container that prints nothing and only exits when it is killed."""

    def __init__(self, docker):
        self.docker = docker
        self.stdout = self
        self.killed = False

    def __iter__(self):
        return self

    def __next__(self):
        while self.docker.running and not self.killed:
            threading.Event().wait(0.02)
        raise StopIteration

    def wait(self, timeout=None):
        return 0

    def kill(self):
        self.killed = True


class RedirectTests(unittest.TestCase):
    """1 (P1): the default opener re-sent Authorization through redirects, cross-origin and to plain http."""

    def serve(self, handler):
        server = http.server.HTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.shutdown)
        return f"http://127.0.0.1:{server.server_port}"

    def test_authenticated_requests_never_follow_a_redirect(self):
        seen = []

        class Collector(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                seen.append(self.headers.get("Authorization"))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"{}")

            def log_message(self, *a):
                pass

        collector = self.serve(Collector)

        class Redirector(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(302)
                self.send_header("Location", collector + "/collect")
                self.end_headers()

            do_POST = do_GET

            def log_message(self, *a):
                pass

        origin = self.serve(Redirector)
        api = Api(origin, KEY)  # the real default opener, a synthetic key
        with self.assertRaises(ApiError) as err:
            api.job("x")
        self.assertEqual(err.exception.status, 302)
        self.assertEqual(seen, [], "the redirect target received no request, so no Authorization header")

    def test_the_refusing_handler_also_covers_https_to_http(self):
        import urllib.request
        from valcairn_runner.api import _RefuseRedirects
        req = urllib.request.Request("https://trusted.invalid/api/runner/jobs/qa", headers={"Authorization": f"Bearer {KEY}"})
        for target in ("https://other.invalid/collect", "http://trusted.invalid/collect", "https://trusted.invalid:8443/x"):
            self.assertIsNone(_RefuseRedirects().redirect_request(req, None, 302, "Found", {}, target), target)


class AuthLossTests(unittest.TestCase):
    """2: a refused key during a job stopped neither the sandbox nor the reporting."""

    def test_a_refused_key_stops_the_work_and_nothing_more_is_sent(self):
        sent, stopped = [], threading.Event()

        class RefusingApi:
            def touch(self, *a):
                sent.append("touch")
                raise AuthError("synthetic revoked key")

            def events(self, *a):
                sent.append("events")
                raise AuthError("synthetic revoked key")

            def finish(self, *a, **k):
                sent.append("finish")
                return {"status": "succeeded"}

        class Box:
            unresolved = None

            def stop(self):
                stopped.set()

            def run(self, step, on_line, cancelled):
                self_cancel = cancelled.wait(2)
                if self_cancel:
                    raise Cancelled()
                return 0

        def handler(ctx):
            ctx.sandbox.run(None, None, ctx.cancelled)
            return {"ok": True}

        job_handlers.HANDLERS["auth"] = handler
        try:
            ended = run_job(RefusingApi(), job("auth"), Box(), FAST, CAPS)
        finally:
            del job_handlers.HANDLERS["auth"]
        self.assertEqual(ended, "unauthorized")
        self.assertTrue(stopped.is_set(), "the sandbox was stopped")
        self.assertNotIn("finish", sent, "no finish under a refused key")
        self.assertEqual(sent.count("touch"), 1, "heartbeats stop after the first refusal")

    def test_serve_stops_taking_work_after_a_refused_key(self):
        class Api:
            leases = 0

            def heartbeat(self, caps):
                return {"runner": {"id": "r", "label": "x"}}

            def lease(self):
                Api.leases += 1
                return job("auth2")

            def touch(self, *a):
                raise AuthError("revoked")

            def events(self, *a):
                return {"job": {}}

        job_handlers.HANDLERS["auth2"] = lambda ctx: (ctx.cancelled.wait(2), {"ok": True})[1]
        import valcairn_runner.runner as r
        real = r.capabilities
        r.capabilities = lambda host: CAPS
        try:
            with self.assertRaises(AuthError):
                serve(Api(), FAST, sandbox=SimpleNamespace(unresolved=None, stop=lambda: None))
        finally:
            r.capabilities = real
            del job_handlers.HANDLERS["auth2"]
        self.assertEqual(Api.leases, 1)


class CancellationContractTests(unittest.TestCase):
    """3: once the runner has seen cancelRequested, the job ends cancelled, even if the handler finished."""

    def test_observed_cancellation_is_reported_as_cancelled(self):
        reported = []

        class Api:
            def touch(self, *a):
                return {"cancelRequested": True}

            def events(self, *a):
                return {"job": {"cancelRequested": True}}

            def finish(self, *a, **outcome):
                reported.append(outcome)
                return {"status": "cancelled"}

        def late(ctx):
            ctx.cancelled.wait(2)  # sees the cancel, then "finishes" its work anyway
            return {"done": True}

        job_handlers.HANDLERS["late"] = late
        try:
            run_job(Api(), job("late"), SimpleNamespace(stop=lambda: None, unresolved=None), FAST, CAPS)
        finally:
            del job_handlers.HANDLERS["late"]
        self.assertEqual(reported, [{"outcome": "failed", "failure": "cancelled"}])


class ContainerStopTests(unittest.TestCase):
    """4, 5: a failed kill was hidden; a cancelled job still launched; a silent process ignored cancellation."""

    def test_a_kill_that_fails_is_not_success_and_holds_the_runner(self):
        docker = Docker(kill_works=False)
        box = Sandbox(popen=lambda *a, **k: SilentProc(docker), run=docker, sleep=lambda s: None)
        cancelled = threading.Event()
        threading.Timer(0.1, cancelled.set).start()
        with self.assertRaises(ContainerNotStopped):
            box.run(Step(image="img", command=["x"], limits=Limits(seconds=30)), lambda line: None, cancelled)
        self.assertIsNotNone(box.unresolved, "the unresolved container is remembered")
        self.assertGreaterEqual(docker.calls.count("kill"), 3, "the kill is retried")
        with self.assertRaises(ContainerNotStopped):
            box.run(Step(image="img", command=["y"]), lambda line: None, threading.Event())

    def test_the_runner_takes_no_more_work_after_an_unresolved_container(self):
        box = SimpleNamespace(unresolved="valcairn-abc", stop=lambda: None)
        with self.assertRaises(RunnerHalted):
            serve(SimpleNamespace(), FAST, sandbox=box)

    def test_nothing_is_launched_for_a_job_already_cancelled(self):
        launches = []
        box = Sandbox(popen=lambda *a, **k: launches.append(a), run=Docker())
        cancelled = threading.Event()
        cancelled.set()
        with self.assertRaises(Cancelled):
            box.run(Step(image="img", command=["x"]), lambda line: None, cancelled)
        self.assertEqual(launches, [])

    def test_a_silent_container_stops_within_a_bounded_time_and_is_confirmed_gone(self):
        docker = Docker()
        box = Sandbox(popen=lambda *a, **k: SilentProc(docker), run=docker, sleep=lambda s: None)
        cancelled = threading.Event()
        threading.Timer(0.1, cancelled.set).start()
        import time
        started = time.monotonic()
        with self.assertRaises(Cancelled):
            box.run(Step(image="img", command=["x"], limits=Limits(seconds=60)), lambda line: None, cancelled)
        self.assertLess(time.monotonic() - started, 5)
        self.assertIn("inspect", docker.calls, "Docker itself confirmed the container is gone")
        self.assertIsNone(box.unresolved)


class HungClientTests(unittest.TestCase):
    """4 (probe failedContainerKill): a docker client that never exits was killed and its 0 reported as success."""

    def test_a_killed_client_is_not_success_and_an_unconfirmed_container_holds_the_runner(self):
        class Hung:
            stdout = iter([])
            killed = False

            def wait(self, timeout=None):
                if not self.killed:
                    raise subprocess.TimeoutExpired("docker", timeout)
                return 0

            def kill(self):
                self.killed = True

        docker = Docker(kill_works=False)
        box = Sandbox(popen=lambda *a, **k: Hung(), run=docker, sleep=lambda s: None)
        with self.assertRaises(ContainerNotStopped):
            box.run(Step(image="img", command=[]), lambda line: None, threading.Event())
        self.assertIn("kill", docker.calls)
        ok = Docker()
        box2 = Sandbox(popen=lambda *a, **k: Hung(), run=ok, sleep=lambda s: None)
        self.assertEqual(box2.run(Step(image="img", command=[]), lambda line: None, threading.Event()), Sandbox.CLIENT_KILLED)


class CloudMarkerTests(unittest.TestCase):
    """6: only remote_host was excluded; remote=true and :cloud names were reported as local."""

    def test_every_cloud_form_is_excluded(self):
        tags = {"models": [
            {"name": "local:1b"}, {"name": "a:cloud"}, {"name": "b-cloud"}, {"name": "c", "remote": True},
            {"name": "d", "remote_host": "https://ollama.com"}, {"name": "e", "remote_model": "x"}, {"name": "cloudy:7b"}, "not a dict",
        ]}
        self.assertEqual([m["name"] for m in local_models(tags)], ["local:1b", "cloudy:7b"])
        self.assertTrue(is_remote({"model": "x:cloud"}))


if __name__ == "__main__":
    unittest.main()
