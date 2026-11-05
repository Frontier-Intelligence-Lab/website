"""Every job step runs in a locked-down Docker container: no network, read-only root, no capabilities, bounded
CPU, memory, processes and time. Inputs are mounted read-only; only /out is writable. GPUs are passed in only
when a step asks for them."""

from __future__ import annotations

import subprocess
import threading
import time
import uuid
from dataclasses import dataclass, field


@dataclass
class Limits:
    cpus: float = 4.0
    memory: str = "8g"
    pids: int = 512
    seconds: int = 3600
    tmpfs_mb: int = 1024
    shm: str = "64m"
    exec_cache_mb: int = 0  # >0 mounts a scratch /cache tmpfs where compiled GPU kernels may be loaded


@dataclass
class Step:
    image: str
    command: list[str]
    gpus: bool = False
    entrypoint: str | None = None  # "" clears the image's own entrypoint (export runs the GGUF converter directly)
    network: str = "none"  # only the fetch step uses "bridge"
    inputs: dict[str, str] = field(default_factory=dict)  # host path -> container path, mounted read-only
    output: str | None = None  # host directory mounted at /out
    env: dict[str, str] = field(default_factory=dict)
    limits: Limits = field(default_factory=Limits)


def docker_args(step: Step, name: str) -> list[str]:
    args = ["docker", "run", "--rm", "--name", name, "--network", step.network, "--read-only",
            "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
            "--pids-limit", str(step.limits.pids), "--memory", step.limits.memory, "--cpus", str(step.limits.cpus),
            "--tmpfs", f"/tmp:rw,noexec,nosuid,size={step.limits.tmpfs_mb}m", "--shm-size", step.limits.shm, "--user", "65534:65534"]
    if step.limits.exec_cache_mb:
        args += ["--tmpfs", f"/cache:rw,exec,nosuid,size={step.limits.exec_cache_mb}m,mode=1777"]
    if step.entrypoint is not None:
        args += ["--entrypoint", step.entrypoint]
    if step.gpus:
        args += ["--gpus", "all"]
    for host, inside in step.inputs.items():
        args += ["--mount", f"type=bind,source={host},target={inside},readonly"]
    if step.output:
        args += ["--mount", f"type=bind,source={step.output},target=/out"]
    for key, value in step.env.items():
        args += ["--env", f"{key}={value}"]
    return [*args, step.image, *step.command]


class Cancelled(Exception):
    pass


class ContainerNotStopped(Exception):
    """A container could not be confirmed stopped. The runner keeps this state and takes no more work."""

    def __init__(self, name: str):
        super().__init__(f"container {name} could not be confirmed stopped")
        self.name = name


STOP_ATTEMPTS = 3
STOP_CHECK_SECONDS = 2.0


class Sandbox:
    """Runs steps and stops them on cancel or timeout. `popen` and `run` are injectable for tests.

    A stop is complete only when Docker itself says the container no longer exists or is not running: a failed
    `docker kill`, or a Docker client that exited, is not proof. If that cannot be confirmed, the container name is
    kept in `unresolved` and every later step is refused until a person checks the machine.

    The container and the docker client are two different things to end. `client_grace` is how long a client may
    keep its output open after its container is confirmed gone before it is killed as well. It is short: a healthy
    client closes its output as soon as its container is dead, `--rm` is honoured by the daemon rather than the
    client, and the exit status of a stopped step is never success anyway."""

    def __init__(self, popen=subprocess.Popen, run=subprocess.run, sleep=time.sleep, client_grace: float = 0.5):
        self._popen = popen
        self._run = run
        self._sleep = sleep
        self._client_grace = client_grace
        self._lock = threading.Lock()
        self._current: str | None = None
        self._stop_requested = False
        self.unresolved: str | None = None

    def _docker(self, args: list[str]):
        try:
            return self._run(["docker", *args], capture_output=True, text=True, timeout=30, check=False)
        except (OSError, subprocess.SubprocessError):
            return None

    def _gone(self, name: str) -> bool:
        """True only when Docker reports the container absent or not running."""
        out = self._docker(["inspect", "-f", "{{.State.Running}}", name])
        if out is None:
            return False
        if out.returncode != 0:
            return "no such" in f"{out.stdout or ''} {out.stderr or ''}".lower()
        return (out.stdout or "").strip() == "false"

    def _stop_and_confirm(self, name: str) -> bool:
        for attempt in range(STOP_ATTEMPTS):
            self._docker(["kill", name])
            if self._gone(name):
                return True
            self._sleep(STOP_CHECK_SECONDS * (attempt + 1))
        return self._gone(name)

    def stop(self) -> None:
        """Asks the running step to stop. The step's watcher kills the container and confirms it is gone."""
        with self._lock:
            self._stop_requested = True

    # Docker's own code for "the docker client itself failed"; used when the client had to be killed.
    CLIENT_KILLED = 125

    def _wait(self, proc, name: str | None = None, grace: float = 60.0) -> int:
        """Waits for the docker client. If it does not exit, the container is killed and confirmed gone, then the
        client is killed too, so the runner never hangs. A client that had to be killed never counts as success:
        its exit status says nothing about the container."""
        try:
            return proc.wait(timeout=grace)
        except subprocess.TimeoutExpired:
            if name and not self._stop_and_confirm(name):
                with self._lock:
                    self.unresolved = name
            proc.kill()
            proc.wait(timeout=grace)
            return self.CLIENT_KILLED

    def run(self, step: Step, on_line, cancelled: threading.Event) -> int:
        """Runs one step, calling on_line for each output line. Returns the exit code; raises Cancelled,
        TimeoutError or ContainerNotStopped."""
        if self.unresolved:
            raise ContainerNotStopped(self.unresolved)
        if cancelled.is_set():
            raise Cancelled()  # nothing is launched for a job that is already cancelled
        name = f"valcairn-{uuid.uuid4().hex[:12]}"
        with self._lock:
            self._current, self._stop_requested = name, False
        timed_out, finished, handled = threading.Event(), threading.Event(), threading.Event()
        # read_ended: this thread is no longer reading the client's output. client_killed: the client was killed.
        read_ended, client_killed = threading.Event(), threading.Event()
        proc = None

        def end_container():
            # Kill, then confirm with Docker. If that cannot be confirmed, remember the container and kill the docker
            # client at once. A confirmed stop says nothing about the client's output: a client that keeps it open
            # would leave this step blocked reading, never reaching the bounded wait, so it gets a short grace to
            # close its output and is then killed too. Either way, this step returns.
            if self._stop_and_confirm(name):
                client_exited = read_ended.wait(self._client_grace)
            else:
                with self._lock:
                    self.unresolved = name
                client_exited = False
            if proc is not None and not client_exited:
                proc.kill()
                client_killed.set()
            handled.set()

        def watch():
            # Cancellation and the time limit do not wait for the next output line: a silent container stops too.
            deadline = time.monotonic() + step.limits.seconds
            while not finished.is_set():
                if cancelled.wait(0.2) or self._stop_requested:
                    return end_container()
                if time.monotonic() >= deadline:
                    timed_out.set()
                    return end_container()

        watcher = threading.Thread(target=watch, daemon=True)
        try:
            proc = self._popen(docker_args(step, name), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
            watcher.start()
            for line in proc.stdout:
                if cancelled.is_set() or timed_out.is_set():
                    break
                on_line(line.rstrip("\n"))
            read_ended.set()
            if (cancelled.is_set() or timed_out.is_set() or self._stop_requested) and not handled.is_set():
                handled.wait(STOP_ATTEMPTS * STOP_CHECK_SECONDS * 4 + 60)
            code = self._wait(proc, name)
            if client_killed.is_set():
                code = self.CLIENT_KILLED  # a killed client's own status says nothing about the container
        except BaseException:
            # Whatever went wrong on this side, the container must not outlive the step.
            finished.set()
            read_ended.set()
            if proc is not None:
                if not handled.is_set():
                    end_container()
                self._wait(proc, name)
            self._release(name)
            raise
        finally:
            finished.set()
        self._release(name)
        if self.unresolved == name:
            raise ContainerNotStopped(name)
        if cancelled.is_set():
            raise Cancelled()
        if timed_out.is_set():
            raise TimeoutError()
        return code

    def _release(self, name: str) -> None:
        with self._lock:
            if self._current == name:
                self._current = None
        if self.unresolved == name:
            raise ContainerNotStopped(name)
