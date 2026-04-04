import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path("/Users/daehan/Documents/persona/paperclip/scripts/topic_alignment_precheck.py")


class TopicAlignmentPrecheckTests(unittest.TestCase):
    def run_script(self, payload: dict, approved_topic: str) -> dict:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "draft.json"
            path.write_text(json.dumps(payload))
            raw = subprocess.check_output(
                [sys.executable, str(SCRIPT), "--draft", str(path), "--approved-topic", approved_topic],
                text=True,
            )
            return json.loads(raw)

    def test_fails_when_numbered_promise_not_in_structure(self):
        result = self.run_script(
            {
                "title": "일반 사용자가 곧 체감할 3가지 변화",
                "sections": [{"title": "배경"}, {"title": "결론"}],
                "ending_judgment": "지금 확인할 사람과 기다릴 사람을 나눈다.",
            },
            "일반 사용자가 곧 체감할 변화",
        )
        self.assertFalse(result["ok"])
        self.assertEqual(result["drift_type"], "title_structure_mismatch")

    def test_fails_when_ending_does_not_pay_off(self):
        result = self.run_script(
            {
                "title": "일반 사용자가 곧 체감할 3가지 변화",
                "sections": [{"title": "변화 1"}, {"title": "변화 2"}, {"title": "변화 3"}],
                "ending_judgment": "기술 배경을 다시 설명한다.",
            },
            "일반 사용자가 곧 체감할 변화",
        )
        self.assertFalse(result["ok"])
        self.assertFalse(result["ending_alignment"])

    def test_passes_when_aligned(self):
        result = self.run_script(
            {
                "title": "일반 사용자가 곧 체감할 3가지 변화",
                "sections": [{"title": "변화 1"}, {"title": "변화 2"}, {"title": "변화 3"}],
                "ending_judgment": "지금 써볼 사람과 기다릴 사람을 나눈다.",
            },
            "일반 사용자가 곧 체감할 변화",
        )
        self.assertTrue(result["ok"])


if __name__ == "__main__":
    unittest.main()
