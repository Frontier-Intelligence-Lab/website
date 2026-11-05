"""Synthetic HTTP servers on 127.0.0.1 for the transport regressions: canned replies, replies that pause or keep
trickling at any point, a server that notices when its client goes, and a self-signed certificate made at test time.
Never a model, never a real Ollama, never anything installed on the machine."""

import select
import shutil
import socket
import ssl
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def loopback(test, respond, tls=None):
    """A synthetic HTTP server on 127.0.0.1 (never a model), over TLS if a server context is given. `respond(handler)`
    returns (status, body, headers) or None to write nothing. Every request is recorded as (method, path)."""
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length", "0")))
            requests.append((self.command, self.path))
            try:
                answer = respond(self)
                if answer is None:
                    return
                status, body, headers = answer
                self.send_response(status)
                for key, value in {"Content-Type": "application/json", "Content-Length": str(len(body)), **headers}.items():
                    self.send_header(key, value)
                self.end_headers()
                self.wfile.write(body)
            except OSError:
                pass  # the client had already gone (a cancelled or timed-out request)

        do_GET = do_POST

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    if tls is not None:
        server.socket = tls.wrap_socket(server.socket, server_side=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    test.addCleanup(lambda: (server.shutdown(), server.server_close(), thread.join(3)))
    return f"{'https' if tls is not None else 'http'}://127.0.0.1:{server.server_port}", requests


def client_gone(handler, timeout):
    """True once the client has shut its side of the connection (what a daemon sees before it has an answer). The
    client sends nothing after its request, so anything readable now is its close (TLS sockets cannot peek)."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if select.select([handler.connection], [], [], 0.05)[0]:
            try:
                if isinstance(handler.connection, ssl.SSLSocket):
                    return handler.connection.recv(1) == b""
                return handler.connection.recv(1, socket.MSG_PEEK) == b""
            except OSError:
                return True
    return False


def paused(sent: bytes, rest: bytes):
    """A daemon that has sent `sent`, then sends nothing (the socket is never readable) until the client goes or the
    test releases it, and then sends `rest`."""
    def behave(handler, entered, release, gone):
        handler.wfile.write(sent)
        entered.set()
        if client_gone(handler, 5):
            gone.set()
            return
        release.wait(1)
        handler.wfile.write(rest)
    return behave


def dripping(sent: bytes):
    """A daemon that has sent `sent`, then keeps sending one more byte about every 40 ms (the socket is readable
    again and again, so no wait ever times out) until the client goes or the test releases it."""
    def behave(handler, entered, release, gone):
        handler.wfile.write(sent)
        entered.set()
        while not release.is_set():
            if client_gone(handler, 0.04):
                gone.set()
                return
            try:
                handler.wfile.write(b"x")
            except OSError:
                gone.set()
                return
    return behave


def synthetic_daemon(test, behave, tls=None):
    """A synthetic server behaving as `behave` (made by `paused` or `dripping`) for the one request it gets."""
    entered, release, gone = threading.Event(), threading.Event(), threading.Event()
    test.addCleanup(release.set)
    url, requests = loopback(test, lambda handler: behave(handler, entered, release, gone), tls)
    return url, requests, entered, release, gone


def synthetic_certificate(test):
    """A self-signed certificate for 127.0.0.1 made with the openssl CLI if this machine has one, trusted by the
    test's own client context and by nothing else; nothing is installed anywhere."""
    openssl = shutil.which("openssl")
    if not openssl:
        test.skipTest("no openssl CLI to make a synthetic certificate")
    folder = Path(tempfile.mkdtemp())
    cert, key = folder / "cert.pem", folder / "key.pem"
    made = subprocess.run([openssl, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(key), "-out", str(cert), "-days", "1",
                           "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], capture_output=True, timeout=120)
    if made.returncode != 0:
        test.skipTest("openssl could not make a synthetic certificate")
    server = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    server.load_cert_chain(cert, key)
    return server, ssl.create_default_context(cafile=str(cert))
