# Valcairn Runner

The Valcairn Runner runs Valcairn jobs on your own machine: a workstation, a GPU server or a laptop. It links to a workspace with a key, leases one job at a time and runs every step in a locked-down Docker sandbox. It talks to the Ollama on the same machine directly. Valcairn never connects to the machine: the Runner calls out over HTTPS, so it needs no open port. The API it uses is documented in [`docs/RUNNERS.md`](../../docs/RUNNERS.md).

| Job | Status |
| --- | --- |
| `probe`: start a sandbox with no network, read the GPUs from inside it, check Ollama | Implemented and run against a real RTX 5090 with Docker Desktop and Ollama 0.40.13. |
| `train`: LoRA fine-tuning of an approved plan's base model on its frozen dataset versions, with held-out loss of the base and the tuned model | Implemented (runner 0.2). Run against a real RTX 5090: on a synthetic 252-example support set with Qwen3-0.6B, held-out loss fell from 4.4707 on the base model to 0.0785 after 58 steps (38 s), with the same adapter hash on a second run. |
| `evaluate`, `export` | **Planned**, as separate increments. A job of these kinds ends as `unsupported` until its handler lands. |

## Requirements

- Python 3.11 or later. The Runner uses only the standard library.
- Docker (Docker Desktop on Windows and macOS). For GPU jobs, add the NVIDIA driver and GPU support in Docker: Docker Desktop on WSL 2, or the NVIDIA Container Toolkit on Linux.
- Optional: Ollama on this machine (`http://127.0.0.1:11434` by default).

## Build the training image (once, for `train`)

```bash
docker build -t valcairn-train:0.1 images/train
```

The image pins PyTorch 2.15 (CUDA 13.4), transformers 5.22.1, peft 0.21.2, trl 1.17.1, accelerate 1.15.0, datasets 5.1.0 and huggingface_hub 2.4.0. It needs an NVIDIA driver that supports CUDA 13.4.

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
| `VALCAIRN_TRAIN_IMAGE` | `valcairn-train:0.1` | The training image built above. |
| `VALCAIRN_RUNNER_HOME` | `~/.valcairn-runner` | Where job inputs, model caches (`models/`) and outputs (`jobs/<id>/attempt-<n>/out`) are kept. |
| `VALCAIRN_TRAIN_MEMORY` | `32g` | Memory limit of the training container. |
| `HF_TOKEN` | none | Not read by the runner today; gated models are not fetched. |

## How a training job runs

1. **Inputs.** The runner asks Valcairn for the job's inputs: the base model's source and short-lived signed links to the frozen files of each dataset version. It downloads the `.jsonl` files, checks each file's SHA-256 against the version's manifest, and refuses any file that does not match.
2. **Weights.** If the base model is not cached, a **fetch** step downloads it into `models/`. This is the only step with network access. It downloads only safetensors weights and plain config and tokenizer files: no pickled weights and no custom code (`trust_remote_code` is off).
3. **Training** runs with `--network none`, with the weights and data mounted read-only. It uses LoRA (rank 32, alpha 64, all linear layers, 2 epochs, bf16). With more than one GPU it runs through `accelerate launch --multi_gpu`.
4. **Held-out comparison.** About 10% of the examples, chosen by a hash of each example's content so the split is reproducible, are never trained on. Their loss is measured on the unchanged base model first, then on the tuned model. The split's hashes are saved as `split.json`.
5. **Result.** The adapter stays on this machine in safetensors. Valcairn receives its SHA-256, size and location, the report (example counts, steps, time, GPUs, peak GPU memory, both held-out losses) and the live loss curve.

Examples are JSON lines: `{"messages": [{"role": "user", "content": "…"}, {"role": "assistant", "content": "…"}]}` or `{"prompt": "…", "completion": "…"}`. Other lines are counted as skipped. Only fine-tuning (`sft`) runs today; preference tuning and reinforcement learning steps in a plan are shown as skipped.

Training steps also get a scratch `/cache` tmpfs where executables are allowed, because Triton compiles GPU kernels there and loads them. It is not persisted, and `/tmp` stays `noexec`.

## What the sandbox allows

Each step runs with `docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --user 65534:65534`, limits on processes, memory, CPU and time, and a small `noexec` `/tmp`. Inputs are bind-mounted read-only, and only `/out` is writable. GPUs are passed in (`--gpus all`) only for steps that need them.

Cancelling in Valcairn stops the container within one heartbeat (15 seconds). If Valcairn reports that the Runner no longer holds the job (an expired lease, or the runner was revoked), the Runner stops the container and reports nothing more.

Failures are reported as a category only (for example `sandbox_unavailable`, `timeout`, `runtime_error`). Raw output stays on this machine.

## Tests

```bash
python -m unittest discover -s tests -v
```
