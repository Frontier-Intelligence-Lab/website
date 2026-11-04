"""Job handlers by kind. Each returns a small result dict or raises JobFailure with a category Valcairn accepts."""

from __future__ import annotations

from .machine import parse_nvidia_smi
from .sandbox import Limits, Step
from .training import JobFailure, train




def probe(ctx) -> dict:
    """Sandbox check: start a locked-down container with the GPUs and read them from inside it."""
    caps = ctx.capabilities
    result = {"hostGpus": len(caps.get("gpus", [])), "ollamaReachable": caps.get("ollama", {}).get("reachable", False)}
    ctx.emit("stage", name="ollama", status="finished" if result["ollamaReachable"] else "skipped")
    if not caps.get("sandbox", {}).get("available"):
        ctx.emit("stage", name="sandbox", status="failed")
        raise JobFailure("sandbox_unavailable", "Docker is not running on this machine.")
    ctx.emit("stage", name="sandbox", status="started")
    use_gpu = bool(caps["sandbox"].get("gpu") and caps.get("gpus"))
    lines: list[str] = []
    step = Step(image=ctx.settings.probe_image, gpus=use_gpu, limits=Limits(cpus=1, memory="512m", pids=64, seconds=120, tmpfs_mb=16),
                command=["nvidia-smi", "--query-gpu=name,memory.total,driver_version", "--format=csv,noheader,nounits"] if use_gpu else ["true"])
    code = ctx.sandbox.run(step, lines.append, ctx.cancelled)
    if code != 0:
        ctx.emit("stage", name="sandbox", status="failed")
        raise JobFailure("sandbox_error", f"The sandbox exited with code {code}.")
    seen = parse_nvidia_smi("\n".join(lines))
    ctx.emit("stage", name="sandbox", status="finished")
    for gpu in seen:
        ctx.emit("metric", name="sandbox_gpu_memory_mb", value=gpu["memoryMb"])
    ctx.log(f"Sandbox started with no network; {len(seen)} GPU(s) visible inside it.")
    return {**result, "sandbox": True, "network": "none", "sandboxGpus": seen}


HANDLERS = {"probe": probe, "train": train}
