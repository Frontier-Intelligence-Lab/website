# Valcairn Runner

The Valcairn Runner runs Valcairn jobs on your own machine: a workstation, a GPU server or a laptop. It links to a workspace with a key, leases one job at a time and runs every step in a locked-down Docker sandbox. It talks to the Ollama on the same machine directly. Valcairn never connects to the machine: the Runner calls out over HTTPS, so it needs no open port. The API it uses is documented in [`docs/RUNNERS.md`](../../docs/RUNNERS.md).

| Job | Status |
| --- | --- |
| `probe`: start a sandbox with no network, read the GPUs from inside it, check Ollama | Implemented and run against a real RTX 5090 with Docker Desktop and Ollama 0.40.13. |
| `train`, `evaluate`, `export` | **Planned**, as separate increments. A job of these kinds ends as `unsupported` until its handler lands. |

## Requirements

- Python 3.11 or later. The Runner uses only the standard library.
- Docker (Docker Desktop on Windows and macOS). For GPU jobs, add the NVIDIA driver and GPU support in Docker: Docker Desktop on WSL 2, or the NVIDIA Container Toolkit on Linux.
- Optional: Ollama on this machine (`http://127.0.0.1:11434` by default).

## Link and run

1. In Valcairn, an owner or admin links a runner and copies the key. The key is shown once.
2. Save the key to a file that only you can read, then start the Runner from this directory:

PowerShell:

```powershell
Set-Content -NoNewline -Path $HOME\.valcairn-runner-key -Value '<paste the key>'
$env:VALCAIRN_URL = 'https://your-valcairn-site'
$env:VALCAIRN_RUNNER_KEY_FILE = "$HOME\.valcairn-runner-key"
uv run valcairn-runner run
```

macOS and Linux:

```bash
umask 077 && printf %s '<paste the key>' > ~/.valcairn-runner-key
VALCAIRN_URL=https://your-valcairn-site VALCAIRN_RUNNER_KEY_FILE=~/.valcairn-runner-key uv run valcairn-runner run
```

`uv run valcairn-runner check` prints what the Runner would report (platform, GPUs, Ollama models, sandbox) without contacting Valcairn. Without uv, use `python -m valcairn_runner run`.

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `VALCAIRN_URL` | required | The Valcairn site origin. It must be `https://`, or `http://` to this machine for local development, because the key is a bearer secret. |
| `VALCAIRN_RUNNER_KEY_FILE` | none | A file holding the key. Preferred over the variable below, so the key stays out of shell history and process listings. |
| `VALCAIRN_RUNNER_KEY` | none | The key itself, if no file is set. |
| `OLLAMA_HOST_URL` | `http://127.0.0.1:11434` | The Ollama on this machine. Cloud models (those with a remote host) are never reported as local. |
| `VALCAIRN_PROBE_IMAGE` | `ubuntu:24.04` | The image the sandbox check starts. |

## What the sandbox allows

Each step runs with `docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --user 65534:65534`, limits on processes, memory, CPU and time, and a small `noexec` `/tmp`. Inputs are bind-mounted read-only, and only `/out` is writable. GPUs are passed in (`--gpus all`) only for steps that need them.

## Stopping, cancelling and lost authority

- **Cancellation.** The runner learns of a cancel on its next heartbeat or event upload, at most every 15 seconds. It then stops the container within about a second, even if the container prints nothing. A job that was already cancelled before a step starts launches nothing. Once the runner has seen the cancel, it reports the job as cancelled, even if the work had finished. Valcairn records the same (`docs/RUNNERS.md`, *Cancellation*).
- **Confirmed stops.** A stop counts only when Docker itself reports the container gone or not running (`docker inspect`). A failed `docker kill`, or a Docker client that exited, is not proof. A Docker client that has to be killed never counts as success. If a container cannot be confirmed stopped after three attempts, the runner reports `sandbox_error`, keeps the container's name and takes no more work. It exits with status 3 until a person checks the machine.
- **Lost authority.** If Valcairn says the runner no longer holds the job (an expired lease, or a cancel that has completed), the runner stops the container and reports nothing more for that job. If Valcairn refuses the key itself (revoked, or its linker no longer manages the workspace), the runner also stops heartbeats, event uploads and the finish report under that key. It then exits with status 2.
- **Redirects.** Requests that carry the key never follow a redirect. Python's default handler would re-send the `Authorization` header to the new location, including another origin or plain `http`. The runner API never redirects, so any redirect is refused as an error.

Failures are reported as a category only (for example `sandbox_unavailable`, `timeout`, `runtime_error`). Raw output stays on this machine.

## Tests

```bash
python -m unittest discover -s tests -v
```
