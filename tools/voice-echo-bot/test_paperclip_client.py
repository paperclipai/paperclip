import json
import unittest
from unittest import mock

import paperclip_client as pc


def _fake_response(payload):
    m = mock.MagicMock()
    m.read.return_value = json.dumps(payload).encode("utf-8")
    m.__enter__.return_value = m
    m.__exit__.return_value = False
    return m


class TestDeriveTitle(unittest.TestCase):
    def test_first_sentence(self):
        self.assertEqual(pc.derive_title("Kaufe Milch. Und Brot."), "Kaufe Milch.")

    def test_truncates_long_text(self):
        long = "wort " * 40
        title = pc.derive_title(long)
        self.assertLessEqual(len(title), 81)
        self.assertTrue(title.endswith("…"))

    def test_empty_fallback(self):
        self.assertEqual(pc.derive_title("   "), "Sprachnotiz")


class TestCreateIssue(unittest.TestCase):
    def test_posts_to_ceo_with_bearer(self):
        with mock.patch("paperclip_client.urllib.request.urlopen",
                        return_value=_fake_response({"id": "iss-1", "shortId": "WHI-999"})) as uo:
            res = pc.create_issue("tok", "comp-1", "ceo-1", "Titel", "Beschreibung")
        self.assertEqual(res["shortId"], "WHI-999")
        req = uo.call_args[0][0]
        self.assertEqual(req.full_url, "http://127.0.0.1:3100/api/companies/comp-1/issues")
        self.assertEqual(req.headers["Authorization"], "Bearer tok")
        body = json.loads(req.data.decode("utf-8"))
        self.assertEqual(body["title"], "Titel")
        self.assertEqual(body["description"], "Beschreibung")
        self.assertEqual(body["assigneeAgentId"], "ceo-1")
        self.assertNotIn("status", body)


if __name__ == "__main__":
    unittest.main()
