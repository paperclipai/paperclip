import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path("/Users/daehan/Documents/persona/paperclip/scripts/reader_experience_precheck.py")


class ReaderExperiencePrecheckTests(unittest.TestCase):
    def run_script(self, payload: dict) -> dict:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "draft.json"
            path.write_text(json.dumps(payload))
            raw = subprocess.check_output([sys.executable, str(SCRIPT), "--draft", str(path)], text=True)
            return json.loads(raw)

    def test_fails_when_ending_payoff_missing(self):
        result = self.run_script({"markdown": "## 목차\n\n이번 글에서 볼 3가지\n\nbody only"})
        self.assertFalse(result["ok"])
        self.assertIn("ending_payoff_missing", result["reasons"])

    def test_fails_when_scan_path_missing(self):
        result = self.run_script({"markdown": "이 글은 길지만 구조 힌트가 없다. " * 80})
        self.assertFalse(result["ok"])
        self.assertIn("scan_path_missing", result["reasons"])

    def test_fails_when_quick_scan_and_checklist_are_missing(self):
        result = self.run_script({"markdown": "## 목차\n\n이번 글에서 볼 3가지\n\n본문 설명만 있고 마지막 행동 포인트가 없다.\n\n판단 문장도 약하다."})
        self.assertFalse(result["ok"])
        self.assertIn("quick_scan_missing", result["reasons"])
        self.assertIn("checklist_or_next_steps_missing", result["reasons"])

    def test_passes_with_hook_and_ending(self):
        result = self.run_script({"markdown": "## 목차\n\n핵심 요약\n\n이번 글에서 볼 3가지\n\n## 왜 중요해졌나\n\nbody\n\n## 누가 먼저 써볼 만한가\n\nbody\n\n## 지금 무엇을 보면 되나\n\n| 비교 | 의미 |\n| --- | --- |\n| A | B |\n\n마지막으로 이것만 확인해보세요\n\n지금 써볼 사람과 기다릴 사람을 판단한다."})
        self.assertTrue(result["ok"])

    def test_fails_dense_article_without_toc(self):
        markdown = (
            "핵심 요약\n\n이번 글에서 볼 3가지\n\n"
            "## 왜 중요해졌나\n\n" + ("설명 문장 " * 180) +
            "\n\n## 누가 먼저 체감하나\n\n" + ("설명 문장 " * 160) +
            "\n\n## 지금 무엇을 보면 되나\n\n" + ("설명 문장 " * 160) +
            "\n\n마지막으로 다음 단계만 확인해보세요."
        )
        result = self.run_script({"markdown": markdown})
        self.assertFalse(result["ok"])
        self.assertIn("toc_missing_for_long_article", result["reasons"])

    def test_fails_dense_article_without_reader_question_structure(self):
        markdown = (
            "## 목차\n\n핵심 요약\n\n이번 글에서 볼 3가지\n\n"
            "## 배경\n\n" + ("설명 문장 " * 180) +
            "\n\n## 세부사항\n\n" + ("설명 문장 " * 160) +
            "\n\n## 추가 정보\n\n" + ("설명 문장 " * 160) +
            "\n\n| 비교 | 의미 |\n| --- | --- |\n| A | B |\n\n마지막으로 다음 단계만 확인해보세요."
        )
        result = self.run_script({"markdown": markdown})
        self.assertFalse(result["ok"])
        self.assertIn("section_question_structure_missing", result["reasons"])


if __name__ == "__main__":
    unittest.main()
