import json
import unittest
from pathlib import Path

from valcairn_runner.case_eval import answer_cases, case_eval
from valcairn_runner.runner import Settings


PASSAGES = [
    {"id": "p1", "citation": "p1", "text": "general warranty text about returns"},
    {"id": "p2", "citation": "p2", "text": "Refunds\nYou have 30 days"},
]


class AnswerTests(unittest.TestCase):
    def test_a_heading_boost_outranks_token_overlap_and_an_empty_source_is_not_an_answer(self):
        plain = answer_cases([{"caseKey": "a", "input": "how long"}], PASSAGES, {"retrievalK": 1, "boosts": []})
        boosted = answer_cases([{"caseKey": "a", "input": "how long"}], PASSAGES, {"retrievalK": 1, "boosts": ["Refunds"]})
        self.assertEqual(plain[0]["citations"], ["p1"])
        self.assertEqual(boosted[0]["citations"], ["p2"])
        self.assertNotIn("scores", boosted[0])
        empty = answer_cases([{"caseKey": "a", "input": "how long"}, {"caseKey": "b", "input": "else"}], [], {"retrievalK": 1})
        self.assertEqual([row["errorKind"] for row in empty], ["no_source", "no_source"])
        self.assertTrue(all(row["output"] is None for row in empty))

    def test_the_recipe_file_does_not_call_a_model(self):
        text = Path(__file__).resolve().parents[1].joinpath("valcairn_runner", "case_eval.py").read_text(encoding="utf-8")
        for banned in ("urllib", "requests", "http.client", "socket"):
            self.assertNotIn(banned, text)


class HandlerTests(unittest.TestCase):
    def test_the_sandbox_has_no_network_and_results_are_posted_in_chunks(self):
        posted = []

        class Api:
            def inputs(self, job_id, token):
                cases = [{"caseKey": f"c{i}", "input": "policy"} for i in range(21)]
                return {"cases": cases, "passages": PASSAGES[:1], "settings": {"retrievalK": 1, "boosts": []}, "recipeVersion": "1"}

            def case_results(self, job_id, token, results):
                posted.append(results)

        class Sandbox:
            def __init__(self):
                self.step = None

            def run(self, step, on_line, cancelled):
                self.step = step
                host = next(path for path, inside in step.inputs.items() if inside == "/in/cases.json")
                payload = json.loads(Path(host).read_text(encoding="utf-8"))
                Path(step.output, "answers.json").write_text(json.dumps(answer_cases(payload["cases"], payload["passages"], payload["settings"])), encoding="utf-8")
                return 0

        class Context:
            cancelled = type("Flag", (), {"is_set": staticmethod(lambda: False)})()
            capabilities = {"sandbox": {"available": True}}
            settings = Settings()
            job = {"id": "job-1", "leaseToken": "token"}
            api = Api()
            sandbox = Sandbox()

        result = case_eval(Context())
        step = Context.sandbox.step
        self.assertEqual(step.network, "none")
        self.assertEqual(step.entrypoint, "")
        self.assertEqual(step.command[-1], "/in/recipe.py")
        self.assertEqual(step.image, Settings().train_image)
        self.assertEqual([len(batch) for batch in posted], [20, 1])
        self.assertEqual(result, {"recipe": "support-qa", "recipeVersion": "1", "answered": 21, "errors": 0})
        self.assertTrue(all("scores" not in row for batch in posted for row in batch))
