"""What this machine offers: GPUs (nvidia-smi), the Docker sandbox and the local Ollama, reported to Valcairn as-is."""

from __future__ import annotations

import json
import platform
import shutil
import subprocess
import urllib.request

from . import __version__


def _run(args: list[str], timeout: float = 15.0) -> str | None:
    if not shutil.which(args[0]):
        return None
    try:
        out = subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return out.stdout if out.returncode == 0 else None


def parse_nvidia_smi(text: str | None) -> list[dict]:
    """Rows of `nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits`."""
    gpus = []
    for line in (text or "").splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) >= 3 and parts[1].isdigit():
            gpus.append({"name": parts[0][:120], "memoryMb": int(parts[1]), "driver": parts[2][:40]})
    return gpus[:16]


def gpus() -> list[dict]:
    return parse_nvidia_smi(_run(["nvidia-smi", "--query-gpu=name,memory.total,driver_version", "--format=csv,noheader,nounits"]))


def sandbox() -> dict:
    version = _run(["docker", "version", "--format", "{{.Server.Version}}"])
    if not version:
        return {"available": False, "engine": "docker"}
    runtimes = _run(["docker", "info", "--format", "{{json .Runtimes}}"]) or "{}"
    try:
        has_gpu = "nvidia" in json.loads(runtimes)
    except ValueError:
        has_gpu = False
    return {"available": True, "engine": "docker", "version": version.strip()[:40], "gpu": has_gpu}


def local_models(tags: dict) -> list[dict]:
    """Installed models from Ollama's /api/tags. Cloud models (remote_host) run elsewhere, so they are left out."""
    models = []
    for m in tags.get("models", []):
        if m.get("remote_host") or m.get("remote_model"):
            continue
        models.append({"name": str(m.get("name", ""))[:200], "digest": (m.get("digest") or None), "sizeBytes": m.get("size")})
    return [m for m in models if m["name"]][:200]


def ollama(host: str, opener=urllib.request.urlopen) -> dict:
    """Ollama on this machine, called directly: no browser, so no OLLAMA_ORIGINS change is needed."""
    try:
        with opener(f"{host}/api/version", timeout=3) as res:
            version = json.loads(res.read()).get("version")
        with opener(f"{host}/api/tags", timeout=5) as res:
            tags = json.loads(res.read())
    except (OSError, ValueError):
        return {"reachable": False, "models": []}
    return {"reachable": True, "version": str(version)[:40] if version else None, "models": local_models(tags)}


def capabilities(ollama_host: str) -> dict:
    return {
        "platform": f"{platform.system().lower()}-{platform.machine().lower()}"[:80],
        "runnerVersion": __version__,
        "gpus": gpus(),
        "ollama": ollama(ollama_host),
        "sandbox": sandbox(),
    }
