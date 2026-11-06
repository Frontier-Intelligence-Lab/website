"""Extractive support-qa recipe. The sandbox runs this file and does not import the package.

The highest-ranked passage is the answer. A heading boost outranks token overlap. An empty
source is no_source for every case. This file does not call a model or open a network connection.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
from pathlib import Path

TOKEN = re.compile(r"[a-z0-9]+")


def _tokens(text: str) -> set[str]:
    return set(TOKEN.findall((text or "").lower()))


def _rank(question: str, passages: list[dict], settings: dict) -> list[dict]:
    depth = int(settings.get("retrievalK") or 1)
    boosts = [str(item).lower() for item in (settings.get("boosts") or []) if str(item).strip()]
    question_tokens = _tokens(question)
    scored = []
    for index, passage in enumerate(passages):
        text = passage.get("text") or ""
        passage_tokens = _tokens(text)
        overlap = len(question_tokens & passage_tokens) / len(question_tokens | passage_tokens) if question_tokens and passage_tokens else 0
        boosted = any(boost and boost in text.lower() for boost in boosts)
        scored.append((1000 + overlap if boosted else overlap, -index, passage))
    scored.sort(key=lambda item: (item[0], item[1]), reverse=True)
    return [item[2] for item in scored[: max(depth, 0)]]


def answer_cases(cases: list[dict], passages: list[dict], settings: dict) -> list[dict]:
    """One answer per case. Scores are not included; the server decides those."""
    if not passages:
        return [{"caseKey": case["caseKey"], "errorKind": "no_source", "output": None, "passages": [], "citations": [], "latencyMs": 0} for case in cases]
    answers = []
    for case in cases:
        picked = _rank(case.get("input") or "", passages, settings)
        top = picked[0]
        answers.append({
            "caseKey": case["caseKey"],
            "errorKind": None,
            "output": (top.get("text") or "")[:8000],
            "passages": [{"text": (item.get("text") or "")[:500], "citation": item.get("citation") or ""} for item in picked],
            "citations": [item.get("citation") for item in picked if item.get("citation")],
            "latencyMs": 0,
        })
    return answers


def case_eval(ctx) -> dict:
    """Run the recipe in the training image with no network, then post the outputs."""
    from .sandbox import Limits, Step
    from .training import JobFailure

    if not ctx.capabilities.get("sandbox", {}).get("available"):
        raise JobFailure("sandbox_unavailable", "Docker is not running on this machine.")
    payload = ctx.api.inputs(ctx.job["id"], ctx.job["leaseToken"])
    if ctx.cancelled.is_set():
        from .sandbox import Cancelled
        raise Cancelled()
    with tempfile.TemporaryDirectory(prefix="case-eval-") as directory:
        root = Path(directory)
        recipe = Path(__file__).resolve()
        cases_path = root / "cases.json"
        out = root / "out"
        out.mkdir()
        os.chmod(out, 0o777)
        body = {"cases": payload["cases"], "passages": payload["passages"], "settings": payload["settings"]}
        cases_path.write_text(json.dumps(body), encoding="utf-8")
        step = Step(
            image=ctx.settings.train_image, command=["python", "/in/recipe.py"], entrypoint="", network="none", gpus=False,
            inputs={str(recipe): "/in/recipe.py", str(cases_path): "/in/cases.json"}, output=str(out),
            limits=Limits(cpus=1, memory="512m", pids=64, seconds=120, tmpfs_mb=64),
        )
        code = ctx.sandbox.run(step, lambda _line: None, ctx.cancelled)
        if code != 0:
            raise JobFailure("sandbox_error", f"The recipe exited with code {code}.")
        try:
            answers = json.loads((out / "answers.json").read_text(encoding="utf-8"))
        except (OSError, ValueError) as err:
            raise JobFailure("runtime_error", "The recipe did not write answers.") from err
    if not isinstance(answers, list):
        raise JobFailure("runtime_error", "The recipe did not write answers.")
    for start in range(0, len(answers), 20):
        ctx.api.case_results(ctx.job["id"], ctx.job["leaseToken"], answers[start:start + 20])
    errors = sum(1 for row in answers if row.get("errorKind"))
    return {"recipe": "support-qa", "recipeVersion": payload.get("recipeVersion") or "", "answered": len(answers) - errors, "errors": errors}


if __name__ == "__main__":
    incoming = json.loads(Path("/in/cases.json").read_text(encoding="utf-8"))
    Path("/out/answers.json").write_text(json.dumps(answer_cases(incoming["cases"], incoming["passages"], incoming["settings"])), encoding="utf-8")
