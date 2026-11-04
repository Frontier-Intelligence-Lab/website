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


@dataclass
class Step:
    image: str
    command: list[str]
    gpus: bool = False
    inputs: dict[str, str] = field(default_factory=dict)  # host path -> container path, mounted read-only
    output: str | None = None  # host directory mounted at /out
    env: dict[str, str] = field(default_factory=dict)
    limits: Limits = field(default_factory=Limits)


def docker_args(step: Step, name: str) -> list[str]:
    args = ["docker", "run", "--rm", "--name", name, "--network", "none", "--read-only",
            "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
            "--pids-limit", str(step.limits.pids), "--memory", step.limits.memory, "--cpus", str(step.limits.cpus),
            "--tmpfs", f"/tmp:rw,noexec,nosuid,size={step.limits.tmpfs_mb}m", "--user", "65534:65534"]
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
        try:
            proc = self._popen(docker_args(step, name), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
            timer.start()
            for line in proc.stdout:
                if cancelled.is_set():
                    self.stop()
                    break
                on_line(line.rstrip("\n"))
            code = proc.wait()
        finally:
            timer.cancel()
            with self._lock:
                self._current = None
        if cancelled.is_set():
            raise Cancelled()
        if timed_out.is_set():
            raise TimeoutError()
        return code
