"""Regressions for the dataset download through signed links: the link policy (https, or http to this machine,
well formed, never a redirect, errors never carrying the link), cancellation and the deadline at any point of a
reply, and the https path for real with a synthetic certificate. Synthetic loopback servers only: no model, no real
link, nothing installed is touched."""

import hashlib
import http.client
import io
import ssl
import tempfile
import threading
import time
import unittest
from pathlib import Path

from fixtures_runner import DATA, TRAIN_JOB, Ctx, Inputs, serve_data
from synthetic_http import dripping, loopback, paused, synthetic_certificate, synthetic_daemon
from valcairn_runner import training
from valcairn_runner.sandbox import Cancelled
from valcairn_runner.training import JobFailure

DATA_BODY = b'{"prompt": "a", "completion": "b"}\n' * 3
DATA_SHA = hashlib.sha256(DATA_BODY).hexdigest()
FILE_HEAD = b"HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: %d\r\n\r\n" % len(DATA_BODY)
# The phases a reply can be in when the cancel or the deadline arrives.
FILE_PHASES = {
    "waiting-headers": paused(b"", FILE_HEAD + DATA_BODY),
    "partial-headers": paused(FILE_HEAD[:30], FILE_HEAD[30:] + DATA_BODY),
    "partial-body": paused(FILE_HEAD + DATA_BODY[:1], DATA_BODY[1:]),
    "dripping-headers": dripping(b"HTTP/1.1 200 OK\r\nX-Filler: "),
    "dripping-body": dripping(b"HTTP/1.1 200 OK\r\nContent-Length: 100000\r\n\r\n"),
}


class DatasetLinks(unittest.TestCase):
    """The inherited finding: any scheme reached urlopen, redirects were followed, and errors carried the link."""

    def test_only_https_or_http_to_this_machine_is_opened(self):
        opened = []
        dest = Path(tempfile.mkdtemp()) / "000.jsonl"
        body = b'{"prompt": "a", "completion": "b"}\n'

        def opener(url, *args, **kwargs):
            opened.append(url)
            return None, io.BytesIO(body)
        for url in ["file:///etc/passwd", "ftp://ingest.example/x", "http://ingest.example/x", "data:,x", "", None, "https://", "http://[::1"]:
            with self.assertRaises(JobFailure, msg=url) as e:
                training.download(url, dest, hashlib.sha256(body).hexdigest(), opener=opener)
            self.assertEqual(e.exception.category, "dataset_error", url)
            if url:
                self.assertNotIn(url, str(e.exception), "the link is not in the message")
        self.assertEqual(opened, [], "no refused link was opened")
        for url in ["https://ingest.example/x?sig=1", "http://127.0.0.1:8080/x", "http://localhost/x", "http://[::1]:9/x"]:
            training.download(url, dest, hashlib.sha256(body).hexdigest(), opener=opener)
        self.assertEqual(len(opened), 4)

    def test_a_malformed_link_is_refused_unopened_and_its_query_is_never_repeated(self):
        """urllib raises http.client.InvalidURL, naming the whole link, for a space in the path; that is not an
        OSError, so it escaped as a handler crash with the signed query in the runner's log."""
        dest = Path(tempfile.mkdtemp()) / "000.jsonl"
        opened = []
        probe = "https://127.0.0.1:1/a path?proof=synthetic-marker"
        for url in [probe, "https://user:pw@ingest.example/x?proof=synthetic-marker", "https://ingest.example:99999/x?proof=synthetic-marker",
                    "https://ingest.example:abc/x?proof=synthetic-marker", "https://ingest.example:0/x?proof=synthetic-marker",
                    "https://ingest.example/x\r\nHost: other?proof=synthetic-marker", "https://ingest.example/caf\u00e9?proof=synthetic-marker",
                    "https://[::1/x?proof=synthetic-marker", "https://ingest.example/x\x7f?proof=synthetic-marker"]:
            with self.assertRaises(JobFailure, msg=url) as e:
                training.download(url, dest, "0" * 64, opener=lambda url, *a, **k: opened.append(url))
            self.assertEqual(e.exception.category, "dataset_error", url)
            self.assertIn("000.jsonl", str(e.exception))
            self.assertNotIn("synthetic-marker", str(e.exception), url)
        self.assertEqual(opened, [], "no malformed link was opened")
        with self.assertRaises(JobFailure) as e:
            training.download(probe, dest, "0" * 64)  # the real opener: refused before any connection is attempted
        self.assertNotIn("synthetic-marker", str(e.exception))
        self.assertEqual(list(dest.parent.iterdir()), [])
        body = b'{"prompt": "a", "completion": "b"}\n'
        good = "https://ingest.example/a%20path/f.jsonl?sig=abc%2Fdef%3D&exp=1"
        training.download(good, dest, hashlib.sha256(body).hexdigest(), opener=lambda url, *a, **k: (opened.append(url), (None, io.BytesIO(body)))[1])
        self.assertEqual(opened, [good], "a percent-encoded signed link is passed through unchanged")

    def test_http_parser_errors_from_a_link_are_sanitized_and_not_chained(self):
        dest = Path(tempfile.mkdtemp()) / "000.jsonl"
        for error in (http.client.InvalidURL("URL can't contain control characters. '/x?proof=synthetic-marker'"), http.client.BadStatusLine("synthetic-marker"),
                      http.client.IncompleteRead(b"synthetic-marker"), OSError("reset by synthetic-marker"), ssl.SSLCertVerificationError("synthetic-marker")):
            def opener(url, *args, error=error, **kwargs):
                raise error
            with self.assertRaises(JobFailure, msg=repr(error)) as e:
                training.download("https://ingest.example/x?proof=synthetic-marker", dest, "0" * 64, opener=opener)
            self.assertEqual((e.exception.category, e.exception.retryable), ("dataset_error", True))
            self.assertIn("000.jsonl", str(e.exception))
            self.assertNotIn("synthetic-marker", str(e.exception))
            self.assertTrue(e.exception.__cause__ is None and e.exception.__suppress_context__, "the original error is not chained into what is logged")
        self.assertEqual(list(dest.parent.iterdir()), [])

    def test_a_signed_link_is_never_followed_through_a_redirect(self):
        url, requests = loopback(self, lambda handler: (302, b"", {"Location": "/elsewhere"}))
        dest = Path(tempfile.mkdtemp()) / "000.jsonl"
        with self.assertRaises(JobFailure) as e:
            training.download(f"{url}/x?sig=SECRET", dest, "0" * 64)  # the real opener: loopback http is allowed
        self.assertEqual((e.exception.category, e.exception.retryable), ("dataset_error", True))
        self.assertNotIn("SECRET", str(e.exception))
        self.assertEqual(requests, [("GET", "/x?sig=SECRET")], "the redirect target was never requested")
        self.assertEqual(list(dest.parent.iterdir()), [])

    def test_the_train_handler_passes_its_cancel_flag_to_every_download(self):
        seen = []
        real = training.open_link
        training.open_link = lambda url, cancelled, deadline, name, context=None: (seen.append((cancelled, name)), (None, io.BytesIO(DATA)))[1]
        self.addCleanup(setattr, training, "open_link", real)
        ctx = Ctx(Path(tempfile.mkdtemp()), TRAIN_JOB, api=Inputs())
        training.train(ctx)
        self.assertEqual(seen, [(ctx.cancelled, "000.jsonl")], "the job's own cancel flag reaches the transfer")

    def test_a_train_job_with_a_refused_link_writes_nothing_and_keeps_nothing(self):
        home = Path(tempfile.mkdtemp())
        serve_data(self)

        class FileLink(Inputs):
            def inputs(self, job_id, token):
                data = super().inputs(job_id, token)
                data["datasets"][0]["files"][0]["url"] = "file:///C:/Windows/win.ini"
                return data
        ctx = Ctx(home, TRAIN_JOB, api=FileLink())
        with self.assertRaises(JobFailure) as e:
            training.train(ctx)
        self.assertEqual(e.exception.category, "dataset_error")
        self.assertEqual(ctx.sandbox.steps, [], "nothing was fetched or trained")
        self.assertFalse((home / "jobs" / TRAIN_JOB / "attempt-1").exists())


class DownloadCancellation(unittest.TestCase):
    """Root's P2: the dataset download took no cancel flag, blocked in a 1 MiB read, could keep bytes that arrived
    with the cancel, and its idle socket timeout did not bound a reply that kept trickling."""

    def download_in_thread(self, url, dest, cancelled, context=None):
        outcome = []

        def run():
            try:
                outcome.append(training.download(f"{url}/x?sig=SECRET", dest, DATA_SHA, cancelled=cancelled, context=context))
            except BaseException as error:  # noqa: BLE001 - the kind of exception is the point
                outcome.append(error)
        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        return thread, outcome

    def test_a_cancel_at_any_point_of_the_reply_stops_the_download_and_keeps_nothing(self):
        for name, behave in FILE_PHASES.items():
            with self.subTest(phase=name):
                url, requests, entered, release, gone = synthetic_daemon(self, behave)
                dest, cancelled = Path(tempfile.mkdtemp()) / "000.jsonl", threading.Event()
                thread, outcome = self.download_in_thread(url, dest, cancelled)
                self.assertTrue(entered.wait(3), "the synthetic request did not start")
                started = time.monotonic()
                cancelled.set()
                thread.join(2)
                self.assertFalse(thread.is_alive(), "the download is still blocked after the cancel")
                self.assertLess(time.monotonic() - started, 1.5)
                self.assertIsInstance(outcome[0], Cancelled, outcome)
                self.assertTrue(gone.wait(2), "the server did not see the client go")
                self.assertEqual(list(dest.parent.iterdir()), [], "no file and no .part remain")

    def test_the_deadline_holds_at_any_point_of_the_reply(self):
        self.addCleanup(setattr, training, "DOWNLOAD_SECONDS", training.DOWNLOAD_SECONDS)
        training.DOWNLOAD_SECONDS = 0.5
        for name, behave in FILE_PHASES.items():
            with self.subTest(phase=name):
                url, requests, entered, release, gone = synthetic_daemon(self, behave)
                dest, started = Path(tempfile.mkdtemp()) / "000.jsonl", time.monotonic()
                with self.assertRaises(JobFailure) as e:
                    training.download(f"{url}/x?sig=SECRET", dest, DATA_SHA, cancelled=threading.Event())
                self.assertEqual((e.exception.category, e.exception.retryable), ("timeout", True))
                self.assertIn("000.jsonl", str(e.exception))
                self.assertNotIn("SECRET", str(e.exception))
                self.assertLess(time.monotonic() - started, 1.5)
                self.assertTrue(gone.wait(2), "the server did not see the client go")
                self.assertEqual(list(dest.parent.iterdir()), [])

    def test_a_cancel_seen_with_the_last_bytes_refuses_the_file(self):
        cancelled = threading.Event()

        def late(handler, entered, release, gone):
            handler.wfile.write(FILE_HEAD + DATA_BODY[:-1])
            entered.set()
            cancelled.set()
            handler.wfile.write(DATA_BODY[-1:])
        url, *_ = synthetic_daemon(self, late)
        dest = Path(tempfile.mkdtemp()) / "000.jsonl"
        with self.assertRaises(Cancelled):
            training.download(f"{url}/x?sig=SECRET", dest, DATA_SHA, cancelled=cancelled)
        self.assertEqual(list(dest.parent.iterdir()), [], "a complete file is not kept once the cancel was seen")

    def test_a_good_file_still_arrives_and_the_other_refusals_still_hold(self):
        reply = [(200, DATA_BODY, {})]
        url, requests = loopback(self, lambda handler: reply[0])
        dest = Path(tempfile.mkdtemp()) / "000.jsonl"
        self.assertEqual(training.download(f"{url}/x?sig=SECRET", dest, DATA_SHA, cancelled=threading.Event()), len(DATA_BODY))
        self.assertEqual(dest.read_bytes(), DATA_BODY)
        dest.unlink()
        with self.assertRaises(JobFailure) as e:
            training.download(f"{url}/x?sig=SECRET", dest, "0" * 64)  # checksum
        self.assertEqual(e.exception.category, "dataset_error")
        with self.assertRaises(JobFailure) as e:
            training.download(f"{url}/x?sig=SECRET", dest, DATA_SHA, budget=10)  # over the job's remaining budget
        self.assertEqual(e.exception.category, "dataset_error")
        reply[0] = (404, b'{"error": "unexpected-marker"}', {})
        with self.assertRaises(JobFailure) as e:
            training.download(f"{url}/x?sig=SECRET", dest, DATA_SHA)
        self.assertEqual((e.exception.category, e.exception.retryable), ("dataset_error", True))
        self.assertNotIn("unexpected-marker", str(e.exception))
        self.assertNotIn("SECRET", str(e.exception))
        self.assertEqual(list(dest.parent.iterdir()), [], "no .part survives any refusal")
        self.assertEqual({r[0] for r in requests}, {"GET"})


class DownloadOverTls(unittest.TestCase):
    """The https path for real, with a synthetic local certificate: certificate checks, and cancellation and the
    deadline while TLS holds decrypted bytes of its own and records arrive in pieces."""

    def setUp(self):
        self.server_tls, self.client_tls = synthetic_certificate(self)

    def test_a_trusted_certificate_downloads_and_an_untrusted_one_is_refused_without_the_link(self):
        url, _ = loopback(self, lambda handler: (200, DATA_BODY, {}), tls=self.server_tls)
        self.assertTrue(url.startswith("https://"))
        dest = Path(tempfile.mkdtemp()) / "000.jsonl"
        training.download(f"{url}/x?sig=SECRET", dest, DATA_SHA, cancelled=threading.Event(), context=self.client_tls)
        self.assertEqual(dest.read_bytes(), DATA_BODY)
        dest.unlink()
        with self.assertRaises(JobFailure) as e:
            training.download(f"{url}/x?sig=SECRET", dest, DATA_SHA)  # the system's trust does not know this certificate
        self.assertEqual((e.exception.category, e.exception.retryable), ("dataset_error", True))
        self.assertNotIn("SECRET", str(e.exception))
        self.assertEqual(list(dest.parent.iterdir()), [])

    def test_a_cancel_and_the_deadline_end_a_dripping_tls_body(self):
        self.addCleanup(setattr, training, "DOWNLOAD_SECONDS", training.DOWNLOAD_SECONDS)
        for mode in ("cancel", "deadline"):
            with self.subTest(mode=mode):
                training.DOWNLOAD_SECONDS = 1800 if mode == "cancel" else 0.5
                url, requests, entered, release, gone = synthetic_daemon(self, FILE_PHASES["dripping-body"], tls=self.server_tls)
                dest, cancelled = Path(tempfile.mkdtemp()) / "000.jsonl", threading.Event()
                thread, outcome = DownloadCancellation.download_in_thread(self, url, dest, cancelled, context=self.client_tls)
                self.assertTrue(entered.wait(3), "the synthetic request did not start")
                started = time.monotonic()
                if mode == "cancel":
                    cancelled.set()
                thread.join(2)
                self.assertFalse(thread.is_alive(), "the download is still blocked")
                self.assertLess(time.monotonic() - started, 1.5)
                self.assertIsInstance(outcome[0], Cancelled if mode == "cancel" else JobFailure, outcome)
                self.assertTrue(gone.wait(2), "the server did not see the client go")
                self.assertEqual(list(dest.parent.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
