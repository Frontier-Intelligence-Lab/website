"""The cooperative transport's own boundary, with fake connections: nothing is sent once a stop is known, whether
the cancel or the deadline arrived before connecting or while connecting. The per-read behaviour (pauses, trickles,
TLS) is pinned through the handlers in test_training_links.py and test_export_cancellation.py."""

import threading
import time
import unittest

from valcairn_runner.sandbox import Cancelled
from valcairn_runner.transport import exchange


class FakeConnection:
    """Counts connects and requests; `on_connect` runs inside connect(), like a slow handshake or a cancel seen then."""

    def __init__(self, on_connect=None):
        self.connected, self.sent, self.on_connect = 0, 0, on_connect
        self.sock = type("Sock", (), {"settimeout": lambda self, seconds: None, "pending": lambda self: 0})()

    def connect(self):
        self.connected += 1
        if self.on_connect:
            self.on_connect()

    def request(self, *args, **kwargs):
        self.sent += 1


def timed_out():
    return TimeoutError("deadline")


class PreDispatchBoundary(unittest.TestCase):
    """Root's probe: a cancel set during connect(), or a deadline used up by connect(), was followed by the request."""

    def test_no_request_once_connecting_saw_a_cancel_or_used_up_the_deadline(self):
        cancelled = threading.Event()
        conn = FakeConnection(cancelled.set)
        with self.assertRaises(Cancelled):
            exchange(conn, "GET", "/synthetic", None, {}, cancelled, time.monotonic() + 3, timed_out)
        self.assertEqual((conn.connected, conn.sent), (1, 0), "connected, then stopped: nothing sent")
        conn = FakeConnection(lambda: time.sleep(0.03))
        with self.assertRaises(TimeoutError):
            exchange(conn, "GET", "/synthetic", None, {}, None, time.monotonic() + 0.01, timed_out)
        self.assertEqual((conn.connected, conn.sent), (1, 0), "the deadline passed while connecting: nothing sent")

    def test_nothing_connects_once_a_stop_is_already_known(self):
        cancelled = threading.Event()
        cancelled.set()
        conn = FakeConnection()
        with self.assertRaises(Cancelled):
            exchange(conn, "GET", "/synthetic", None, {}, cancelled, time.monotonic() + 3, timed_out)
        self.assertEqual((conn.connected, conn.sent), (0, 0))
        conn = FakeConnection()
        with self.assertRaises(TimeoutError):
            exchange(conn, "GET", "/synthetic", None, {}, None, time.monotonic() - 1, timed_out)
        self.assertEqual((conn.connected, conn.sent), (0, 0))


if __name__ == "__main__":
    unittest.main()
