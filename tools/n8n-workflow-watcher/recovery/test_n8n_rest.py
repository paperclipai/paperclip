# test_n8n_rest.py
import json
import os
import tempfile
import unittest
from unittest import mock
import n8n_rest as r


class LoadApiKey(unittest.TestCase):
    def test_env_wins(self):
        with mock.patch.dict(os.environ, {"N8N_API_KEY": "env-key"}):
            self.assertEqual(r.load_api_key(), "env-key")

    def test_from_whitestag_env_file(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, ".whitestag.env")
            with open(p, "w") as fh:
                fh.write("# comment\nOTHER=1\nN8N_API_KEY=file-key\nMORE=2\n")
            with mock.patch.dict(os.environ, {}, clear=True):
                self.assertEqual(r.load_api_key(env_file=p), "file-key")

    def test_handles_quoted_value(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, ".whitestag.env")
            with open(p, "w") as fh:
                fh.write('N8N_API_KEY="quoted-key"\n')
            with mock.patch.dict(os.environ, {}, clear=True):
                self.assertEqual(r.load_api_key(env_file=p), "quoted-key")

    def test_missing_returns_empty(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(r.load_api_key(env_file="/no/such/file"), "")


class GetWorkflow(unittest.TestCase):
    def _resp(self, payload, status=200):
        resp = mock.MagicMock()
        resp.status = status
        resp.read.return_value = json.dumps(payload).encode()
        resp.__enter__.return_value = resp
        return resp

    def test_get_sends_key_header_and_parses_active(self):
        resp = self._resp({"id": "wf1", "active": True, "triggerCount": 1})
        with mock.patch.object(r.urllib.request, "urlopen", return_value=resp) as uo:
            out = r.get_workflow("http://127.0.0.1:5678", "k", "wf1")
        self.assertTrue(out["active"])
        req = uo.call_args.args[0]
        self.assertEqual(req.full_url, "http://127.0.0.1:5678/api/v1/workflows/wf1")
        self.assertEqual(req.get_header("X-n8n-api-key"), "k")
        self.assertEqual(req.get_method(), "GET")

    def test_401_raises(self):
        err = r.urllib.error.HTTPError("u", 401, "no key", {}, None)
        with mock.patch.object(r.urllib.request, "urlopen", side_effect=err):
            with self.assertRaises(r.N8nApiError):
                r.get_workflow("http://127.0.0.1:5678", "", "wf1")


if __name__ == "__main__":
    unittest.main()
