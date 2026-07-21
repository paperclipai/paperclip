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


class TestReturnChannel(unittest.TestCase):
    def test_add_comment_posts_body_and_resume(self):
        with mock.patch("paperclip_client.urllib.request.urlopen",
                        return_value=_fake_response({"id": "c1"})) as uo:
            pc.add_comment("tok", "iss-1", "Meine Antwort", resume=True)
        req = uo.call_args[0][0]
        self.assertEqual(req.full_url, "http://127.0.0.1:3100/api/issues/iss-1/comments")
        self.assertEqual(req.headers["Authorization"], "Bearer tok")
        body = json.loads(req.data.decode("utf-8"))
        self.assertEqual(body["body"], "Meine Antwort")
        self.assertTrue(body["resume"])

    def test_find_issue_by_identifier(self):
        issues = {"issues": [{"id": "a", "identifier": "WHI-1"}, {"id": "b", "identifier": "WHI-2"}]}
        with mock.patch("paperclip_client.urllib.request.urlopen", return_value=_fake_response(issues)):
            found = pc.find_issue_by_identifier("tok", "comp", "WHI-2")
        self.assertEqual(found["id"], "b")

    def test_resolve_label_id_matches_name(self):
        labels = [{"id": "l1", "name": "andere"}, {"id": "l2", "name": "entscheidung-noetig"}]
        with mock.patch("paperclip_client.urllib.request.urlopen", return_value=_fake_response(labels)):
            self.assertEqual(pc.resolve_label_id("tok", "comp", "entscheidung-noetig"), "l2")

    def test_list_issues_appends_assignee_query(self):
        with mock.patch("paperclip_client.urllib.request.urlopen",
                        return_value=_fake_response({"issues": []})) as uo:
            pc.list_issues("tok", "comp", assignee_agent_id="ceo-1")
        self.assertIn("?assigneeAgentId=ceo-1", uo.call_args[0][0].full_url)

    def test_list_issues_appends_label_query(self):
        with mock.patch("paperclip_client.urllib.request.urlopen",
                        return_value=_fake_response({"issues": []})) as uo:
            pc.list_issues("tok", "comp", label_id="l2")
        self.assertIn("?labelId=l2", uo.call_args[0][0].full_url)


if __name__ == "__main__":
    unittest.main()
