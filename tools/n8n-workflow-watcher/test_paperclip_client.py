import json
import os
import tempfile
import unittest
from unittest import mock
import paperclip_client as pc

AUTH = {"version": 1, "credentials": {
    "http://localhost:3100": {"apiBase": "http://localhost:3100",
                              "token": "tok-abc-123", "userId": "u1"}}}


class LoadToken(unittest.TestCase):
    def test_loads_nested_token(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "auth.json")
            with open(p, "w") as fh:
                json.dump(AUTH, fh)
            self.assertEqual(pc.load_token(p), "tok-abc-123")

    def test_missing_file_returns_empty(self):
        self.assertEqual(pc.load_token("/no/such/auth.json"), "")


class CreateIssue(unittest.TestCase):
    def test_posts_issue_and_returns_id(self):
        resp = mock.MagicMock()
        resp.status = 201
        resp.read.return_value = json.dumps({"id": "issue-1"}).encode()
        resp.__enter__.return_value = resp
        with mock.patch.object(pc.urllib.request, "urlopen", return_value=resp) as uo:
            issue_id = pc.create_issue(
                "http://localhost:3100", "tok", "cid-1",
                title="T", description="D",
                assignee_agent_id="agent-9", priority="high")
        self.assertEqual(issue_id, "issue-1")
        req = uo.call_args.args[0]
        self.assertEqual(req.full_url, "http://localhost:3100/api/companies/cid-1/issues")
        self.assertEqual(req.get_header("Authorization"), "Bearer tok")
        body = json.loads(req.data.decode())
        self.assertEqual(body["title"], "T")
        self.assertEqual(body["assigneeAgentId"], "agent-9")
        self.assertEqual(body["priority"], "high")

    def test_omits_assignee_when_none(self):
        resp = mock.MagicMock()
        resp.status = 201
        resp.read.return_value = json.dumps({"id": "issue-2"}).encode()
        resp.__enter__.return_value = resp
        with mock.patch.object(pc.urllib.request, "urlopen", return_value=resp) as uo:
            pc.create_issue("http://localhost:3100", "tok", "cid-1",
                            title="T", description="D",
                            assignee_agent_id=None, priority="medium")
        body = json.loads(uo.call_args.args[0].data.decode())
        self.assertNotIn("assigneeAgentId", body)

    def test_http_error_raises_apierror(self):
        err = pc.urllib.error.HTTPError("u", 400, "bad", {}, None)
        with mock.patch.object(pc.urllib.request, "urlopen", side_effect=err):
            with self.assertRaises(pc.ApiError):
                pc.create_issue("http://localhost:3100", "tok", "cid-1",
                                title="T", description="D",
                                assignee_agent_id=None, priority="medium")


class AddComment(unittest.TestCase):
    def test_posts_comment(self):
        resp = mock.MagicMock()
        resp.status = 201
        resp.read.return_value = b"{}"
        resp.__enter__.return_value = resp
        with mock.patch.object(pc.urllib.request, "urlopen", return_value=resp) as uo:
            pc.add_comment("http://localhost:3100", "tok", "issue-1", "hello")
        req = uo.call_args.args[0]
        self.assertEqual(req.full_url, "http://localhost:3100/api/issues/issue-1/comments")
        self.assertEqual(json.loads(req.data.decode())["body"], "hello")


if __name__ == "__main__":
    unittest.main()
