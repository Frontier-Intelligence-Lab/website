"""The shared example rules (valcairn_runner/examples.py, shipped unchanged into the training image as
images/train/examples.py): what counts as an example, how examples are split, and that both copies agree.

These tests use the two copies of the rules, the image's other files as text, and the standard library only: no job
handler, fixture, Docker, model or Ollama. HeldOutIntegrity and ImageParser come from the independent PR16 review
(comment 6638291593); ConversationContract from its parser follow-up."""

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

from valcairn_runner import examples

HERE = Path(__file__).resolve().parent.parent
IMAGE_EXAMPLES = HERE / "images" / "train" / "examples.py"


def image_module():
    """The image's own example rules, loaded from the file the image copies (no ML imports)."""
    spec = importlib.util.spec_from_file_location("image_examples", IMAGE_EXAMPLES)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def chat(i, answer="a"):
    return {"messages": [{"role": "user", "content": f"q{i}"}, {"role": "assistant", "content": answer}]}


class HeldOutIntegrity(unittest.TestCase):
    """1 (P1): the fallback moved one row out of a duplicate group, so the same example was trained on and held out."""

    def test_identical_examples_stay_on_one_side_with_zero_overlap(self):
        image = image_module()
        for distinct in range(5, 40):
            rows = [chat(i) for i in range(distinct)] + [chat(0)] * 4 + [chat(1)] * 3  # duplicate groups
            train, held = image.split(rows)
            self.assertTrue(held, distinct)
            self.assertFalse({image.digest(e) for e in train} & {image.digest(e) for e in held}, f"{distinct} distinct: overlap")
            self.assertEqual(len(train) + len(held), len(rows))

    def test_five_identical_examples_fail_clearly_instead_of_leaking(self):
        image = image_module()
        with self.assertRaises(image.SplitError):
            image.split([chat(0)] * 5)
        with self.assertRaises(image.SplitError):
            image.split([chat(i) for i in range(4)] * 3)

    def test_the_overlap_check_itself_refuses(self):
        with self.assertRaises(examples.SplitError):
            examples.check_disjoint([chat(1)], [chat(1)])


class ImageParser(unittest.TestCase):
    """8: non-object JSON rows crashed the image loader; answer-first chats gave an empty prompt; .JSONL was missed."""

    def test_the_image_loader_counts_non_objects_and_bad_order_as_skipped(self):
        image = image_module()
        folder = Path(tempfile.mkdtemp())
        lines = ["[1, 2]", "null", "7", '"text"', "{not json", json.dumps({"messages": [{"role": "assistant", "content": "a"}, {"role": "user", "content": "q"}]}),
                 json.dumps({"messages": [{"role": "user", "content": "  "}, {"role": "assistant", "content": "a"}]}), json.dumps({"prompt": "", "completion": "x"}),
                 json.dumps(chat(1)), json.dumps({"prompt": "p", "completion": "c"})]
        (folder / "UPPER.JSONL").write_text("\n".join(lines), encoding="utf-8")
        (folder / "notes.txt").write_text(json.dumps(chat(9)), encoding="utf-8")
        rows, skipped = image.load_examples(folder)
        self.assertEqual((len(rows), skipped), (2, 8))
        self.assertTrue(all(image.prompt_turns(r) and any(m["role"] == "user" for m in image.prompt_turns(r)) for r in rows))

    def test_runner_and_image_rules_are_the_same_file(self):
        self.assertEqual((HERE / "valcairn_runner" / "examples.py").read_bytes(), IMAGE_EXAMPLES.read_bytes())
        self.assertIn("examples.py", (HERE / "images" / "train" / "Dockerfile").read_text(), "the image ships the shared rules")
        self.assertIn("from examples import", (HERE / "images" / "train" / "train.py").read_text())


class ConversationContract(unittest.TestCase):
    """A chat ending with an unanswered user turn was accepted: trained on in full, scored on the earlier answer, and
    given a split identity per trailing variant, so one scored answer could sit on both sides of the split."""

    def rules(self):
        return [examples, image_module()]

    def test_a_chat_must_end_with_the_assistant_answer_that_is_scored(self):
        complete = [{"role": "system", "content": "s"}, {"role": "user", "content": "q1"}, {"role": "assistant", "content": "a1"},
                    {"role": "user", "content": "q2"}, {"role": "assistant", "content": "a2"}]
        for rules in self.rules():
            ex = rules.normalise({"messages": complete})
            self.assertEqual(ex, {"messages": complete}, "a completed multi-turn chat is kept whole")
            self.assertEqual(rules.prompt_turns(ex), complete[:-1], "everything before the scored answer is the prompt")
            for trailing in ([{"role": "user", "content": "unanswered"}], [{"role": "system", "content": "later"}], [{"role": "user", "content": ""}]):
                self.assertIsNone(rules.normalise({"messages": complete + trailing}), trailing)
            self.assertIsNone(rules.normalise({"messages": complete[:3] + [{"role": "user", "content": "q2"}]}))

    def test_trailing_variants_are_skipped_so_one_scored_answer_has_one_identity(self):
        folder = Path(tempfile.mkdtemp())
        scored = [{"role": "user", "content": "q"}, {"role": "assistant", "content": "a"}]
        variants = [{"messages": scored + [{"role": "user", "content": f"later {i}"}]} for i in range(5)]
        (folder / "data.jsonl").write_text("\n".join(json.dumps(r) for r in [*variants, {"messages": scored}]), encoding="utf-8")
        for rules in self.rules():
            rows, skipped = rules.load_examples(folder)
            self.assertEqual((len(rows), skipped), (1, 5))
            self.assertEqual(len({rules.digest(r) for r in rows}), 1)
            self.assertEqual(rules.prompt_turns(rows[0]) + [rows[0]["messages"][-1]], rows[0]["messages"], "the identity covers the prompt and the scored answer only")


if __name__ == "__main__":
    unittest.main()
