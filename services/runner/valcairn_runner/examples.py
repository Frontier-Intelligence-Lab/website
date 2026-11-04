"""Which lines are training examples, and how they are split into training and held-out sets.

The same file is copied into the training image (images/train/examples.py; a test keeps the two identical), so the
runner and the image agree on every example, hash and split. Standard library only.
"""

import hashlib
import json
from pathlib import Path

HOLDOUT_EVERY = 10  # about one distinct example in ten is held out
MIN_DISTINCT = 5  # fewer distinct examples than this cannot be split honestly


class SplitError(ValueError):
    """The examples cannot be split into training and held-out sets without overlap."""


def _turn(m) -> bool:
    return isinstance(m, dict) and m.get("role") in ("system", "user", "assistant") and isinstance(m.get("content"), str)


def normalise(row):
    """A chat whose last assistant answer follows a non-empty user turn, or a prompt/completion pair with a non-empty
    prompt. Anything else (other JSON values, other shapes, an answer with no question before it) is None."""
    if not isinstance(row, dict):
        return None
    messages = row.get("messages")
    if isinstance(messages, list) and messages and all(_turn(m) for m in messages):
        last = max((i for i, m in enumerate(messages) if m["role"] == "assistant"), default=-1)
        if last > 0 and any(m["role"] == "user" and m["content"].strip() for m in messages[:last]):
            return {"messages": messages}
        return None
    prompt, completion = row.get("prompt"), row.get("completion")
    if isinstance(prompt, str) and prompt.strip() and isinstance(completion, str):
        return {"messages": [{"role": "user", "content": prompt}, {"role": "assistant", "content": completion}]}
    return None


def is_data_file(path: Path) -> bool:
    """A .jsonl file, in any letter case."""
    return path.is_file() and path.suffix.lower() == ".jsonl"


def load_examples(folder):
    """Usable examples from every .jsonl file under `folder`, in a stable order, and the number of lines skipped."""
    examples, skipped = [], 0
    for path in sorted(p for p in Path(folder).rglob("*") if is_data_file(p)):
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            if not line.strip():
                continue
            try:
                ex = normalise(json.loads(line))
            except ValueError:
                ex = None
            if ex is None:
                skipped += 1
            else:
                examples.append(ex)
    return examples, skipped


def digest(ex) -> str:
    return hashlib.sha256(json.dumps(ex, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def prompt_turns(ex) -> list:
    """The conversation up to (not including) its last assistant answer: what a model is asked."""
    messages = ex["messages"]
    return messages[: max(i for i, m in enumerate(messages) if m["role"] == "assistant")]


def check_disjoint(train, held) -> None:
    overlap = {digest(e) for e in train} & {digest(e) for e in held}
    if overlap:
        raise SplitError(f"{len(overlap)} example(s) would be both trained on and held out.")


def split(examples, holdout_every=HOLDOUT_EVERY):
    """Training and held-out examples. Identical examples form one group and the whole group goes to one side, chosen
    by its content hash, so the split is reproducible and no held-out example is also trained on. If no group falls
    into the held-out share, one whole group is held out. Fails with SplitError when there are too few distinct
    examples to do this and still train on at least four."""
    groups: dict[str, list] = {}
    for ex in examples:
        groups.setdefault(digest(ex), []).append(ex)
    if len(groups) < MIN_DISTINCT:
        raise SplitError(f"Need at least {MIN_DISTINCT} distinct usable examples; found {len(groups)}.")
    held_keys = {k for k in groups if int(k[:8], 16) % holdout_every == 0} or {max(groups)}
    if len(groups) - len(held_keys) < MIN_DISTINCT - 1:
        raise SplitError(f"Only {len(groups) - len(held_keys)} distinct examples would be left to train on; need {MIN_DISTINCT - 1}.")
    train = [ex for k, group in groups.items() if k not in held_keys for ex in group]
    held = [ex for k, group in groups.items() if k in held_keys for ex in group]
    check_disjoint(train, held)
    return train, held
