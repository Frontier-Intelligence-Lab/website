"""Every job step runs in a locked-down Docker container: no network, read-only root, no capabilities, bounded
CPU, memory, processes and time. Inputs are mounted read-only; only /out is writable. GPUs are passed in only
when a step asks for them."""

from __future__ import annotations

import subprocess
import threading
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
    entrypoint: str | None = None  # "" clears the image's own entrypoint
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


class Sandbox:
    """Runs steps and stops them on cancel or timeout. `runner` is injectable for tests."""

    def __init__(self, popen=subprocess.Popen, run=subprocess.run):
        self._popen = popen
        self._run = run
        self._lock = threading.Lock()
        self._current: str | None = None

    def stop(self) -> None:
        with self._lock:
            name = self._current
        if name:
            self._run(["docker", "kill", name], capture_output=True, timeout=30, check=False)

    def _wait(self, proc, grace: float = 60.0) -> int:
        """Waits for the docker client; if it does not exit after a kill, it is killed too, so the runner never hangs."""
        try:
            return proc.wait(timeout=grace)
        except subprocess.TimeoutExpired:
            self.stop()
            proc.kill()
            return proc.wait(timeout=grace)

    def run(self, step: Step, on_line, cancelled: threading.Event) -> int:
        """Runs one step, calling on_line for each output line. Returns the exit code; raises Cancelled or TimeoutError."""
        name = f"valcairn-{uuid.uuid4().hex[:12]}"
        with self._lock:
            self._current = name
        timed_out = threading.Event()

        def on_timeout():
            timed_out.set()
            self.stop()

        timer = threading.Timer(step.limits.seconds, on_timeout)
        proc = None
        try:
            proc = self._popen(docker_args(step, name), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
            timer.start()
            for line in proc.stdout:
                if cancelled.is_set():
                    self.stop()
                    break
                on_line(line.rstrip("\n"))
            code = self._wait(proc)
        except BaseException:
            # Whatever went wrong on this side, the container must not outlive the step.
            self.stop()
            if proc is not None:
                self._wait(proc)
            raise
        finally:
            timer.cancel()
            with self._lock:
                self._current = None
        if cancelled.is_set():
            raise Cancelled()
        if timed_out.is_set():
            raise TimeoutError()
        return code
