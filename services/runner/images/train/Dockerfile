# Valcairn training image: LoRA fine-tuning, held-out evaluation and adapter export.
# Built once on the runner machine; jobs run it with no network (the fetch step alone may reach Hugging Face).
# Versions are pinned; update them together after checking release notes and advisories.
FROM pytorch/pytorch:2.15.0-cuda13.4-cudnn9-runtime

# Torch is in the base image's system Python, which has no ensurepip for a venv. This image has one purpose,
# so the pinned packages go into that Python directly (PEP 668's flag for exactly this case).
RUN pip install --no-cache-dir --break-system-packages \
      transformers==5.22.1 \
      peft==0.21.2 \
      trl==1.17.1 \
      accelerate==1.15.0 \
      datasets==5.1.0 \
      huggingface_hub==2.4.0 \
      safetensors==0.8.0

# /cache is a scratch tmpfs the runner mounts with exec allowed: Triton compiles GPU kernels there and loads them.
ENV HOME=/cache \
    TRITON_CACHE_DIR=/cache/triton \
    HF_HOME=/tmp/hf \
    HF_HUB_DISABLE_TELEMETRY=1 \
    TRANSFORMERS_NO_ADVISORY_WARNINGS=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

COPY fetch.py train.py /app/
WORKDIR /app
USER 65534:65534
