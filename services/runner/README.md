# Valcairn Runner

The Valcairn Runner runs Valcairn jobs on your own machine: a workstation, a GPU server or a laptop. It links to a workspace with a key, leases one job at a time and runs every step in a locked-down Docker sandbox. It talks to the Ollama on the same machine directly. Valcairn never connects to the machine: the Runner calls out over HTTPS, so it needs no open port. The API it uses is documented in [`docs/RUNNERS.md`](../../docs/RUNNERS.md).

| Job | Status |
| --- | --- |
| `probe`: start a sandbox with no network, read the GPUs from inside it, check Ollama | Implemented and run against a real RTX 5090 with Docker Desktop and Ollama 0.40.13. |
| `train`: LoRA fine-tuning of an approved plan's base model on its frozen dataset versions, with held-out loss of the base and the tuned model | Implemented (runner 0.2). Author-reported run on a real RTX 5090, before the lineage and split repairs of runner 0.4: on a synthetic 252-example support set with Qwen3-0.6B, held-out loss fell from 4.4707 on the base model to 0.0785 after 58 steps (38 s). Not independently reproduced. |
| Held-out answers (part of `train`): base and tuned each answer the held-out examples; token F1 and exact match against the reference | Implemented. Same author-reported run: token F1 21.7% → 99.1%, exact match 0% → 83% on 24 held-out examples. These show adaptation to a narrow, templated synthetic task; token F1 is not the customer's acceptance rule. |
| `export`: merge the adapter, convert base and tuned to GGUF (Q8_0), load both into Ollama on this machine, load-test them on held-out conversations, then publish under the final name with a manifest and model card | Implemented (lineage checks, provisional names and local-only Ollama). Author-reported earlier run: a 639 MB GGUF in native Ollama 0.40.13, 468 tok/s tuned against 453 tok/s base. Not rerun after the repairs. |
| `evaluate` | **Planned**. A job of this kind ends as `unsupported` until its handler lands. |

## Requirements

- Python 3.11 or later. The Runner uses only the standard library.
- Docker (Docker Desktop on Windows and macOS). For GPU jobs, add the NVIDIA driver and GPU support in Docker: Docker Desktop on WSL 2, or the NVIDIA Container Toolkit on Linux.
- Optional: Ollama on this machine (`http://127.0.0.1:11434` by default).

## Build the training image (once per runner release, for `train`)

```bash
docker build -t valcairn-train:0.4.0 images/train
```

The image pins PyTorch 2.15 (CUDA 13.4), transformers 5.22.1, peft 0.21.2, trl 1.17.1, accelerate 1.15.0, datasets 5.1.0 and huggingface_hub 2.4.0. It needs an NVIDIA driver that supports CUDA 13.4.

The tag follows the runner release because the image ships the runner's shared example rules (`images/train/examples.py`); an older image would apply older rules to the same job. The runner uses `valcairn-train:0.4.0` unless `VALCAIRN_TRAIN_IMAGE` says otherwise and never falls back to another tag: when the image is missing, Docker cannot start the step (`Unable to find image … locally`, exit code 125), the job fails, and the runner's own log shows why. An earlier `valcairn-train:0.1` is left alone; remove it by hand with `docker image rm` once you no longer need it. A tag is a mutable local name, not an immutable identity. To pin the exact build, set `VALCAIRN_TRAIN_IMAGE` to its image ID (the `sha256:…` value from `docker image inspect -f '{{.Id}}' valcairn-train:0.4.0`, which `docker run` accepts); the training manifest records the configured image reference as it is, so it then names that exact build. The converter image is already pinned by digest (`VALCAIRN_CONVERT_IMAGE`).

## Export to Ollama

An export job names a finished training run on the same runner. Valcairn freezes the adapter's SHA-256 and the training manifest's SHA-256 into the job. Before anything else the runner checks that the training manifest is that one, and that the adapter (weights, config, tokenizer), the split, the dataset files and the cached base model (source, revision and every file) all still match it. Any difference stops the export with `model_unavailable`. It then:

1. Merges the adapter into the base model in the training image, with no network. The base model's tokenizer files are copied unchanged.
2. converts the tuned model and the base model to GGUF q8_0. The base GGUF is made once per runner for the same base files, converter and quantization, and its SHA-256 is checked on every reuse; an altered one stops the export. This uses llama.cpp's published image, pinned by digest (`VALCAIRN_CONVERT_IMAGE`), with no network.
3. loads both into the Ollama on this machine with `ollama create`: the tuned model under a provisional name, `valcairn-p-<job>-a<attempt>`, and the base model as `valcairn-base-<GGUF hash>`. `OLLAMA_HOST_URL` must be plain `http` on this machine (127.0.0.1, localhost or ::1); the CLI is given that address explicitly, so an inherited `OLLAMA_HOST` cannot send the weights elsewhere. If every training example used the same system prompt, it becomes the tuned model's default.
4. load-tests both on up to three held-out conversations (greedy decoding), using Ollama's own token counters for speed. Only then is the tuned model copied to its final name, `valcairn-<job>-a<attempt>`, and the provisional one removed. Nothing is created over an existing name, so a retry never replaces an earlier result or a model made by hand.
5. Writes `manifest.json` (base, adapter and GGUF hashes, quantization, Ollama names), `MODEL_CARD.md` and the base model's `LICENSE` next to the GGUF.

Earlier exports stay in Ollama under their own names, so rolling back means using the previous name; `ollama rm <name>` removes one. Cancellation and lost authority are checked before each conversion, model creation and load test, and a running `ollama create` is stopped. A failed or cancelled export removes its provisional model and its working files.

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
| `VALCAIRN_TRAIN_IMAGE` | `valcairn-train:0.4.0` | The training image built above: a tag, or an image ID to pin one build. No other tag is tried when it is missing. |
| `VALCAIRN_RUNNER_HOME` | `~/.valcairn-runner` | Where job inputs, model caches (`models/`) and outputs (`jobs/<id>/attempt-<n>/out`) are kept. |
| `VALCAIRN_TRAIN_MEMORY` | `32g` | Memory limit of the training container. |
| `HF_TOKEN` | none | not read by the runner today; gated models are not fetched. |

Not yet verified: the writable output folders under the sandbox user (UID 65534) on Linux hosts, and the pinned packages and images resolving together on a fresh machine. Record the image digests you built before claiming a run is reproducible.

## How a training job runs

1. **Inputs.** The runner checks that the job id is a Valcairn UUID and the attempt a small number before any path is built from them, and every folder it writes or removes must stay inside the runner home without passing through a link. It asks Valcairn for the job's inputs: the base model's source and short-lived signed links to the frozen files of each dataset version. A link must be a well-formed `https://` link (verified against the system's certificate trust), or `http://` to this machine for development; any other scheme or a malformed link is refused unopened (a `file:` link would read a local file as dataset bytes), a redirect is never followed, and only a 200 reply is accepted. It downloads the `.jsonl` files (any letter case; up to 2 GB each and 20 GB together), checks each file's SHA-256 against the version's manifest, and refuses any file that does not match. Each file has a total download deadline (30 minutes, whatever its size) and, while it downloads, the runner keeps looking at the cancel flag: a cancel or lost authority stops the transfer at once, closes the connection, removes the partial file, and never keeps a file whose last bytes arrived with the cancel. Partial downloads are always deleted, and a failed download is reported by file name, never by link.
2. **Weights.** If the base model is not cached, a **fetch** step resolves the revision to one commit and downloads it into `models/<name>-<hash of source and revision>/`, recording the source, the commit and every file's SHA-256. Each later use checks that record, so another source, a changed config or tokenizer, or altered weights are fetched again rather than trained on. This is the only step with network access. It downloads only safetensors weights and plain config and tokenizer files: no pickled weights and no custom code (`trust_remote_code` is off).
3. **Training** runs with `--network none`, with the weights and data mounted read-only. It uses LoRA (rank 32, alpha 64, all linear layers, 2 epochs, bf16). With more than one GPU it runs through `accelerate launch --multi_gpu`.
4. **Held-out comparison.** About one distinct example in ten, chosen by a hash of its content so the split is reproducible, is held out. Identical examples stay together on one side, so no held-out example is also in the training split; with fewer than five distinct usable examples the job fails with `dataset_error` instead. The rules are in `valcairn_runner/examples.py`, which the image ships unchanged (`images/train/examples.py`). Their loss is measured on the unchanged base model first, then on the tuned model. The split's hashes are saved as `split.json`.
5. **Result.** The adapter stays on this machine in safetensors, with `manifest.json`: the base model's source, revision and file hashes, the dataset files, the split, the settings and the adapter's files. Valcairn receives the adapter's SHA-256, size and location, the manifest's SHA-256, the base model's revision and hashes, the report (example counts, steps, time, GPUs, peak GPU memory, both held-out losses) and the live loss curve. These numbers are measured and reported by the runner. A successful run's dataset files stay under `jobs/<id>/` so export can find the held-out prompts; a failed or cancelled attempt keeps none of them.

Examples are JSON lines: `{"messages": [{"role": "user", "content": "…"}, {"role": "assistant", "content": "…"}]}`, ending with the assistant answer that is scored and with a non-empty user turn before it (longer completed chats are fine), or `{"prompt": "…", "completion": "…"}` with a non-empty prompt. Other lines, including JSON that is not an object and chats whose last turn is an unanswered user turn, are counted as skipped. Only fine-tuning (`sft`) runs today; preference tuning and reinforcement learning steps in a plan are shown as skipped.

Training steps also get a scratch `/cache` tmpfs where executables are allowed, because Triton compiles GPU kernels there and loads them. It is not persisted, and `/tmp` stays `noexec`.

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
