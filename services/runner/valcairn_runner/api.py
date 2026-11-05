"""The Valcairn runner API (docs/RUNNERS.md) over HTTPS with the runner's bearer key."""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request

from . import __version__

LOOPBACK = {"localhost", "127.0.0.1", "::1"}


class _RefuseRedirects(urllib.request.HTTPRedirectHandler):
    """urllib's default handler re-sends the Authorization header to wherever a 3xx points, including another
    origin and plain http. The runner API never redirects, so every redirect is refused and surfaces as an error."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def authenticated_opener():
    return urllib.request.build_opener(_RefuseRedirects).open


class AuthError(Exception):
    """The key is wrong or revoked, or the person who linked the runner no longer manages the workspace."""


class LeaseLost(Exception):
    """Valcairn no longer considers this runner the holder of the job (expired, cancelled or revoked)."""


class ApiError(Exception):
    def __init__(self, status: int, body: dict):
        super().__init__(f"HTTP {status}: {body.get('error', 'request failed')}")
        self.status = status
        self.body = body


def check_base_url(url: str) -> str:
    """The key is a bearer secret: it may only travel over HTTPS, or plain HTTP to this machine for development."""
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme not in ("https", "http") or not parsed.hostname:
        raise ValueError("VALCAIRN_URL must be an http(s) URL")
    if parsed.scheme == "http" and parsed.hostname not in LOOPBACK:
        raise ValueError("VALCAIRN_URL must use https unless it points at this machine")
    if parsed.path not in ("", "/") or parsed.query or parsed.fragment:
        raise ValueError("VALCAIRN_URL must be the site origin only, for example https://valcairn.example")
    return f"{parsed.scheme}://{parsed.netloc}"


class Api:
    def __init__(self, base_url: str, key: str, timeout: float = 30.0, opener=None):
        self.base = check_base_url(base_url)
        if not key.startswith("vrk_"):
            raise ValueError("The runner key starts with vrk_")
        self._key = key
        self.timeout = timeout
        self._open = opener or authenticated_opener()

    def _call(self, method: str, path: str, body: dict | None = None) -> dict:
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.base + path, data=data, method=method, headers={
            "authorization": f"Bearer {self._key}",
            "user-agent": f"valcairn-runner/{__version__}",
            **({"content-type": "application/json"} if data is not None else {}),
        })
        try:
            with self._open(req, timeout=self.timeout) as res:
                return json.loads(res.read() or b"{}")
        except urllib.error.HTTPError as err:
            try:
                payload = json.loads(err.read() or b"{}")
            except ValueError:
                payload = {}
            if err.code == 401:
                raise AuthError(payload.get("error", "unauthorized")) from None
            if err.code == 409 and payload.get("code") == "lease_lost":
                raise LeaseLost(payload.get("error", "lease lost")) from None
            raise ApiError(err.code, payload) from None

    def heartbeat(self, capabilities: dict) -> dict:
        return self._call("POST", "/api/runner/heartbeat", {"capabilities": capabilities})

    def lease(self) -> dict | None:
        return self._call("POST", "/api/runner/lease", {}).get("job")

    def job(self, job_id: str) -> dict:
        return self._call("GET", f"/api/runner/jobs/{urllib.parse.quote(job_id)}")["job"]

    def touch(self, job_id: str, token: str) -> dict:
        return self._call("POST", f"/api/runner/jobs/{urllib.parse.quote(job_id)}/heartbeat", {"leaseToken": token})["job"]

    def events(self, job_id: str, token: str, events: list[dict]) -> dict:
        return self._call("POST", f"/api/runner/jobs/{urllib.parse.quote(job_id)}/events", {"leaseToken": token, "events": events})

    def inputs(self, job_id: str, token: str) -> dict:
        return self._call("POST", f"/api/runner/jobs/{urllib.parse.quote(job_id)}/inputs", {"leaseToken": token})

    def finish(self, job_id: str, token: str, **outcome) -> dict:
        return self._call("POST", f"/api/runner/jobs/{urllib.parse.quote(job_id)}/finish", {"leaseToken": token, **outcome})["job"]
