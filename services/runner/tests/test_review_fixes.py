"""Regressions for the independent PR14 reviews (comment 6637438951; the b4e8 follow-up). Each test fails on the
reviewed head it names and passes after."""

import http.server
import subprocess
import threading
import time
import unittest
from types import SimpleNamespace

from valcairn_runner import jobs as job_handlers
from valcairn_runner.api import Api, ApiError, AuthError, LeaseLost
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


class StuckProc:
    """A docker client whose output stays open after Docker reports its container gone: only a kill closes it. Its
    wait() answers 0 regardless, as in the review probe, so the client's own status can never stand for success."""

    def __init__(self, lines=()):
        self.lines, self.stdout, self.released, self.kills = list(lines), self, threading.Event(), 0

    def __iter__(self):
        return self

    def __next__(self):
        if self.lines:
            return self.lines.pop(0)
        self.released.wait(10)  # bounded, so a regression fails the test instead of hanging the suite
        raise StopIteration

    def wait(self, timeout=None):
        return 0

    def kill(self):
        self.kills += 1
        self.released.set()


class RedirectTests(unittest.TestCase):
    """1 (P1): the default opener re-sent Authorization through redirects, cross-origin and to plain http."""

    def serve(self, handler):
        server = http.server.HTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)  # cleanups run last-in first-out: shutdown, then close the socket
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


class StuckClientTests(unittest.TestCase):
    """b4e8 F1: Docker confirmed the container gone, but the client kept its output open, and the step stayed
    blocked reading it forever, never reaching the bounded wait."""

    def stuck(self, docker, lines=(), client_grace=0.05):
        proc = StuckProc(lines)
        return proc, Sandbox(popen=lambda *a, **k: proc, run=docker, sleep=lambda s: None, client_grace=client_grace)

    def test_a_client_that_keeps_its_output_open_is_killed_once_the_container_is_confirmed_gone(self):
        for mode, limits, expected in (("cancel", Limits(seconds=60), Cancelled), ("timeout", Limits(seconds=0), TimeoutError)):
            with self.subTest(mode):
                docker, cancelled = Docker(), threading.Event()
                proc, box = self.stuck(docker)
                if mode == "cancel":
                    threading.Timer(0.1, cancelled.set).start()
                started = time.monotonic()
                with self.assertRaises(expected):
                    box.run(Step(image="img", command=["x"], limits=limits), lambda line: None, cancelled)
                self.assertLess(time.monotonic() - started, 5, "the step returned although the client never closed its output")
                self.assertIn("inspect", docker.calls, "Docker itself confirmed the container gone")
                self.assertEqual(proc.kills, 1, "the client was killed after the container was confirmed gone")
                self.assertIsNone(box.unresolved, "a confirmed stop does not hold the runner")

    def test_a_client_killed_after_a_stop_is_never_success(self):
        docker = Docker()
        proc, box = self.stuck(docker)
        threading.Timer(0.1, box.stop).start()
        code = box.run(Step(image="img", command=["x"], limits=Limits(seconds=60)), lambda line: None, threading.Event())
        self.assertEqual(code, Sandbox.CLIENT_KILLED, "the killed client's own 0 is not reported")
        self.assertEqual(proc.kills, 1)

    def test_an_unconfirmed_container_still_holds_the_runner_and_ends_the_client_at_once(self):
        proc, box = self.stuck(Docker(kill_works=False), client_grace=30)  # the grace is for confirmed stops only
        started = time.monotonic()
        with self.assertRaises(ContainerNotStopped):
            box.run(Step(image="img", command=["x"], limits=Limits(seconds=0)), lambda line: None, threading.Event())
        self.assertLess(time.monotonic() - started, 5)
        self.assertEqual(proc.kills, 1)
        self.assertIsNotNone(box.unresolved)

    def test_a_client_that_closes_its_output_on_its_own_is_not_killed(self):
        docker = Docker()
        proc = SilentProc(docker)
        box = Sandbox(popen=lambda *a, **k: proc, run=docker, sleep=lambda s: None)
        cancelled = threading.Event()
        threading.Timer(0.1, cancelled.set).start()
        with self.assertRaises(Cancelled):
            box.run(Step(image="img", command=["x"], limits=Limits(seconds=60)), lambda line: None, cancelled)
        self.assertFalse(proc.killed, "a client that ended with its container needs no kill")
        self.assertIsNone(box.unresolved)

    def test_a_step_that_ends_on_its_own_kills_nothing(self):
        docker, lines = Docker(), []
        proc, box = self.stuck(docker, lines=["one\n", "two\n"])
        proc.released.set()  # the client closes its output right after its lines, as a finished container's does
        self.assertEqual(box.run(Step(image="img", command=["x"]), lines.append, threading.Event()), 0)
        self.assertEqual(lines, ["one", "two"])
        self.assertEqual((proc.kills, docker.calls), (0, []), "no kill, no inspect: nothing was stopped")

    def test_a_failing_line_handler_does_not_wait_out_the_client_grace(self):
        docker = Docker()
        proc, box = self.stuck(docker, lines=["one\n"], client_grace=30)

        def bad(line):
            raise RuntimeError("handler bug")
        started = time.monotonic()
        with self.assertRaises(RuntimeError):
            box.run(Step(image="img", command=["x"]), bad, threading.Event())
        self.assertLess(time.monotonic() - started, 5, "the step's own thread reads no more, so no grace is waited")
        self.assertIn("kill", docker.calls, "the container was still stopped")


class FinalFlushCancellationTests(unittest.TestCase):
    """b4e8 F2: a cancel first seen in the final event flush was followed by a finish that reported success."""

    class Api:
        def __init__(self, finish_failures=0):
            self.reported, self.finish_failures = [], finish_failures

        def touch(self, *a):
            raise AssertionError("no heartbeat is expected during this short job")

        def events(self, *a):
            return {"job": {"cancelRequested": True}}

        def finish(self, *a, **outcome):
            self.reported.append(outcome)
            if len(self.reported) <= self.finish_failures:
                raise OSError("synthetic network failure")
            return {"status": "cancelled" if outcome.get("failure") == "cancelled" else outcome["outcome"]}

    def run_short(self, api):
        stops = []

        def done(ctx):
            ctx.emit("log", level="info", message="synthetic done")  # the only event: it is sent by the final flush
            return {"ok": True}

        job_handlers.HANDLERS["short"] = done
        try:
            ended = run_job(api, job("short"), SimpleNamespace(stop=lambda: stops.append(True), unresolved=None), Settings(touch_seconds=60), CAPS)
        finally:
            del job_handlers.HANDLERS["short"]
        self.assertTrue(stops, "the runner observed the cancel and stopped the sandbox")
        return ended

    def test_a_cancel_first_seen_in_the_final_flush_ends_the_job_cancelled(self):
        api = self.Api()
        self.assertEqual(self.run_short(api), "cancelled")
        self.assertEqual(api.reported, [{"outcome": "failed", "failure": "cancelled"}])

    def test_a_retried_finish_cannot_revive_success(self):
        api = self.Api(finish_failures=1)
        self.assertEqual(self.run_short(api), "cancelled")
        self.assertEqual(api.reported, [{"outcome": "failed", "failure": "cancelled"}] * 2, "every attempt reports the cancel")


class FinishAuthorityTests(unittest.TestCase):
    """Root review of the b4e8 repair: authority was checked once before the finish loop, so a key refused or a
    lease lost while a finish attempt was failing was still used for the retry after the backoff."""

    def finish_while_authority_is_refused(self, refusal):
        seen, sent = {}, []

        class Api:
            def touch(self, *a):
                raise refusal("synthetic refusal")  # the heartbeat reply that revokes authority

            def events(self, *a):
                return {"job": {}}

            def finish(self, *a, **outcome):
                sent.append(outcome)
                if len(sent) == 1:
                    seen["ctx"].touch()  # the in-flight heartbeat is answered while this attempt is failing
                    raise OSError("synthetic transport failure")
                return {"status": "succeeded"}

        def handler(ctx):
            seen["ctx"] = ctx  # the real JobContext, so the refusal travels its real path
            return {"ok": True}

        job_handlers.HANDLERS["authority"] = handler
        try:
            ended = run_job(Api(), job("authority"), SimpleNamespace(stop=lambda: None, unresolved=None), Settings(touch_seconds=60), CAPS)
        finally:
            del job_handlers.HANDLERS["authority"]
        self.assertEqual(sent, [{"outcome": "succeeded", "result": {"ok": True}}], "one finish, before the refusal; none after it")
        return ended

    def test_a_key_refused_while_a_finish_attempt_fails_ends_the_retries(self):
        self.assertEqual(self.finish_while_authority_is_refused(AuthError), "unauthorized")

    def test_a_lease_lost_while_a_finish_attempt_fails_ends_the_retries(self):
        self.assertEqual(self.finish_while_authority_is_refused(LeaseLost), "lost")


if __name__ == "__main__":
    unittest.main()
