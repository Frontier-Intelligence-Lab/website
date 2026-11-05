"""One cooperative HTTP transport for the runner's own HTTP exchanges: the load-test requests to the Ollama on this
machine and the dataset downloads through signed links.

The request is sent and the reply parsed by http.client as usual; only the waiting is done here. Every read first
looks at the job's cancel flag (which also stands for a lost lease or lost authority) and at the exchange's
deadline, and waits at most one short slice at a time, so a reply that pauses or keeps trickling bytes can be
cancelled or timed out at any point: before the status line, inside the headers or inside the body. TLS keeps
decrypted bytes of its own and may need more than one packet for one record; both cases are handled. Nothing is
retried, a connection is never reopened on its own, and no redirect is followed (http.client follows none)."""

from __future__ import annotations

import http.client
import io
import select
import socket
import time

from .sandbox import Cancelled

WAIT_SLICE = 0.2  # how often the cancel flag is looked at while waiting for bytes


class CooperativeReader(io.RawIOBase):
    """A raw stream over a connected socket, for http.client to parse a reply through."""

    def __init__(self, sock, cancelled, deadline: float, on_timeout):
        super().__init__()
        self._sock, self._cancelled, self._deadline, self._on_timeout = sock, cancelled, deadline, on_timeout
        self._pending = getattr(sock, "pending", lambda: 0)  # decrypted bytes TLS already holds

    def readable(self) -> bool:
        return True

    def readinto(self, buffer) -> int:
        """The cancel flag and the deadline are looked at before every wait and every read, and a wait never lasts
        longer than the time left, so a reply that keeps trickling bytes (always readable) cannot outrun either."""
        while True:
            if self._cancelled is not None and self._cancelled.is_set():
                raise Cancelled()
            remaining = self._deadline - time.monotonic()
            if remaining <= 0:
                raise self._on_timeout()
            if not (self._pending() or select.select([self._sock], [], [], min(WAIT_SLICE, remaining))[0]):
                continue
            try:
                return self._sock.recv_into(buffer)
            except TimeoutError:
                continue  # a TLS record was not complete within a slice; the flags are looked at again

    def makefile(self, mode: str = "rb") -> io.BufferedReader:
        return io.BufferedReader(self)  # what HTTPResponse asks of the socket it is given


def stop_if_due(cancelled, deadline: float, on_timeout) -> None:
    """Raises `Cancelled` once the cancel flag is set, or the deadline's exception once the deadline has passed."""
    if cancelled is not None and cancelled.is_set():
        raise Cancelled()
    if time.monotonic() >= deadline:
        raise on_timeout()


def exchange(conn: http.client.HTTPConnection, method: str, path: str, body, headers: dict, cancelled, deadline: float, on_timeout) -> http.client.HTTPResponse:
    """Connects `conn` (for an HTTPSConnection that includes the handshake, under the connection's own connect
    timeout), sends one request and returns the reply with its status line and headers read cooperatively. The
    caller reads the body from the same reply, then calls `shutdown`. `on_timeout` makes the exception raised
    when the deadline passes. Connecting itself is bounded by the connect timeout, not by the flag; but nothing
    is sent once a stop is known: the flag and the deadline are looked at before connecting and again after it."""
    stop_if_due(cancelled, deadline, on_timeout)
    conn.connect()
    stop_if_due(cancelled, deadline, on_timeout)  # connecting may have seen the cancel or used up the time
    conn.auto_open = 0  # a connection that was shut down is never silently reopened
    conn.request(method, path, body=body, headers=headers)
    conn.sock.settimeout(WAIT_SLICE)  # no read blocks past one slice; the reader does the waiting
    res = http.client.HTTPResponse(CooperativeReader(conn.sock, cancelled, deadline, on_timeout), method=method)
    res.begin()  # status line and headers, packet by packet
    return res


def shutdown(conn: http.client.HTTPConnection) -> None:
    """Ends the connection both ways, so the other side sees this client go at once, then closes it."""
    if conn.sock is not None:
        try:
            conn.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
    conn.close()
