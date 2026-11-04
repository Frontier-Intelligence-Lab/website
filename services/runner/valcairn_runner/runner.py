"""The runner loop: report the machine, lease one job, run it, report progress, honour cancel, finish once."""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass

from .api import Api, ApiError, AuthError, LeaseLost
from .jobs import HANDLERS, JobFailure
from .machine import capabilities
from .sandbox import Cancelled, ContainerNotStopped, Sandbox

log = logging.getLogger("valcairn_runner")


class RunnerHalted(Exception):
    """The runner stops taking work: its key was refused, or a container could not be confirmed stopped."""


@dataclass
class Settings:
    ollama_host: str = "http://127.0.0.1:11434"
    probe_image: str = "ubuntu:24.04"
    poll_seconds: float = 5.0
    report_seconds: float = 30.0
    touch_seconds: float = 15.0


class JobContext:
    """What a handler sees: its spec, the sandbox, a progress reporter, and whether it was cancelled."""

    def __init__(self, api: Api, job: dict, sandbox: Sandbox, settings: Settings, caps: dict):
        self.api, self.job, self.sandbox, self.settings, self.capabilities = api, job, sandbox, settings, caps
        self.spec = job["spec"]
        # cancelled: Valcairn asked to stop (or authority was lost). lost: this runner no longer holds the job.
        # unauthorized: the key itself was refused; nothing more is sent under it.
        self.cancelled = threading.Event()
        self.lost = threading.Event()
        self.unauthorized = threading.Event()
        self.cancel_requested = threading.Event()
        self._seq = 0
        self._pending: list[dict] = []
        self._lock = threading.Lock()
        # One flush at a time, so a failed batch is put back before any later batch is sent: order is kept.
        self._flushing = threading.Lock()

    def emit(self, kind: str, **data) -> None:
        with self._lock:
            self._pending.append({"seq": self._seq, "kind": kind, "data": data})
            self._seq += 1
            full = len(self._pending) >= 20
        if full:
            self.flush()

    def log(self, message: str, level: str = "info") -> None:
        self.emit("log", level=level, message=message[:2000])

    def flush(self) -> None:
        """Send buffered events. A failed send keeps them; the same sequence numbers make the retry safe."""
        if not self._flushing.acquire(blocking=False):
            return  # another thread is sending; it keeps the order
        try:
            self._send()
        finally:
            self._flushing.release()

    def _send(self) -> None:
        if self.lost.is_set():
            return
        with self._lock:
            batch, self._pending = self._pending[:50], self._pending[50:]
        if not batch:
            return
        try:
            reply = self.api.events(self.job["id"], self.job["leaseToken"], batch)
            self._note(reply["job"])
        except LeaseLost:
            self._lose()
        except AuthError:
            self._lose(unauthorized=True)
        except ApiError as err:
            # Refused as invalid: resending cannot help, so the batch is dropped (and the reason logged here).
            if err.status == 400:
                log.warning("Valcairn refused %s event(s): %s", len(batch), err.body.get("errors"))
            else:
                with self._lock:
                    self._pending = batch + self._pending
        except OSError:
            with self._lock:
                self._pending = batch + self._pending

    def touch(self) -> None:
        if self.lost.is_set():
            return
        try:
            self._note(self.api.touch(self.job["id"], self.job["leaseToken"]))
        except LeaseLost:
            self._lose()
        except AuthError:
            self._lose(unauthorized=True)
        except (OSError, ApiError) as err:
            log.warning("heartbeat failed: %s", err)

    def _note(self, job: dict) -> None:
        if job.get("cancelRequested") and not self.cancelled.is_set():
            self.cancel_requested.set()
            self.cancelled.set()
            self.sandbox.stop()

    def _lose(self, unauthorized: bool = False) -> None:
        """Authority is gone: stop the work and send nothing more under this lease (or, if the key was refused,
        under this key at all)."""
        if unauthorized:
            self.unauthorized.set()
        self.lost.set()
        self.cancelled.set()
        self.sandbox.stop()


def run_job(api: Api, job: dict, sandbox: Sandbox, settings: Settings, caps: dict) -> str:
    """Runs one leased job to its end and returns the reported outcome."""
    ctx = JobContext(api, job, sandbox, settings, caps)
    stop = threading.Event()

    def keep_alive():
        while not stop.wait(settings.touch_seconds):
            ctx.flush()
            ctx.touch()

    beat = threading.Thread(target=keep_alive, daemon=True)
    beat.start()
    handler = HANDLERS.get(job["kind"])
    outcome: dict
    try:
        if handler is None:
            outcome = {"outcome": "failed", "failure": "unsupported"}
        else:
            outcome = {"outcome": "succeeded", "result": handler(ctx)}
    except Cancelled:
        outcome = {"outcome": "failed", "failure": "cancelled"}
    except ContainerNotStopped as err:
        log.error("job %s: %s; this runner takes no more work until the machine is checked", job["id"], err)
        outcome = {"outcome": "failed", "failure": "sandbox_error"}
    except TimeoutError:
        outcome = {"outcome": "failed", "failure": "timeout"}
    except JobFailure as err:
        ctx.log(str(err), "error")
        outcome = {"outcome": "failed", "failure": err.category, "retryable": err.retryable}
    except Exception:  # noqa: BLE001 - a handler bug must still end the job, with a category only
        log.exception("job %s failed", job["id"])
        outcome = {"outcome": "failed", "failure": "runtime_error"}
    finally:
        stop.set()
        beat.join(timeout=5)
    # The cancellation contract shared with Valcairn (docs/RUNNERS.md): once the runner has seen cancelRequested,
    # the job ends cancelled, even if the handler had already finished its work. Valcairn records it that way too.
    if ctx.cancelled.is_set() and outcome.get("failure") != "sandbox_error":
        outcome = {"outcome": "failed", "failure": "cancelled"}
    if ctx.unauthorized.is_set():
        log.error("job %s: Valcairn refused this runner's key during the job; nothing more is reported under it", job["id"])
        return "unauthorized"
    for _ in range(3):
        ctx.flush()
    if ctx.unauthorized.is_set():
        return "unauthorized"
    if ctx.lost.is_set():
        log.warning("job %s: Valcairn no longer holds this runner's lease; not reporting", job["id"])
        return "lost"
    for attempt in range(5):
        try:
            return api.finish(job["id"], job["leaseToken"], **outcome)["status"]
        except LeaseLost:
            return "lost"
        except AuthError:
            log.error("job %s: Valcairn refused this runner's key when it reported the end", job["id"])
            return "unauthorized"
        except (OSError, ApiError) as err:
            log.warning("finish failed (%s), retrying", err)
            time.sleep(2 ** attempt)
    return "unreported"


def serve(api: Api, settings: Settings, sandbox: Sandbox | None = None, once: bool = False) -> None:
    """Runs until stopped. A revoked key or an unresolved container ends the loop; network errors back off and retry."""
    sandbox = sandbox or Sandbox()
    if sandbox.unresolved:
        raise RunnerHalted(f"container {sandbox.unresolved} could not be confirmed stopped")
    caps, reported, backoff = {}, 0.0, settings.poll_seconds
    while True:
        try:
            if time.monotonic() - reported >= settings.report_seconds or not caps:
                caps = capabilities(settings.ollama_host)
                me = api.heartbeat(caps)["runner"]
                if not reported:
                    log.info("linked as %s (%s)", me["label"], me["id"])
                reported = time.monotonic()
            job = api.lease()
            backoff = settings.poll_seconds
            if job:
                log.info("job %s (%s), attempt %s", job["id"], job["kind"], job["attempt"])
                ended = run_job(api, job, sandbox, settings, caps)
                log.info("job %s ended: %s", job["id"], ended)
                if ended == "unauthorized":
                    raise AuthError("the runner key was refused during a job")
                if sandbox.unresolved:
                    raise RunnerHalted(f"container {sandbox.unresolved} could not be confirmed stopped; check the machine, then restart the runner")
                continue
        except AuthError as err:
            log.error("Valcairn refused this runner: %s", err)
            raise
        except (OSError, ApiError) as err:
            log.warning("Valcairn unreachable (%s); retrying in %.0fs", err, backoff)
            backoff = min(backoff * 2, 300)
        if once:
            return
        time.sleep(backoff)
