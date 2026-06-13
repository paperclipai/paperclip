# test_n8n_health.py
import unittest
from unittest import mock
import n8n_health as h

PS_SAMPLE = ("/usr/bin/node /path/n8n start N8N_BLOCK_ENV_ACCESS_IN_NODE=false "
             "NODE_FUNCTION_ALLOW_BUILTIN=fs,path PATH=/usr/bin OTHER=x")


class ParseEnvFlags(unittest.TestCase):
    def test_extracts_known_flags(self):
        out = h.parse_env_flags(PS_SAMPLE)
        self.assertEqual(out["N8N_BLOCK_ENV_ACCESS_IN_NODE"], "false")
        self.assertEqual(out["NODE_FUNCTION_ALLOW_BUILTIN"], "fs,path")

    def test_absent_flag_is_none(self):
        out = h.parse_env_flags("/usr/bin/node n8n start PATH=/usr/bin")
        self.assertIsNone(out["N8N_BLOCK_ENV_ACCESS_IN_NODE"])
        self.assertIsNone(out["NODE_FUNCTION_ALLOW_BUILTIN"])

    def test_empty_input(self):
        out = h.parse_env_flags("")
        self.assertIsNone(out["N8N_BLOCK_ENV_ACCESS_IN_NODE"])


class Healthz(unittest.TestCase):
    def test_true_on_200(self):
        resp = mock.MagicMock()
        resp.status = 200
        resp.__enter__.return_value = resp
        with mock.patch.object(h.urllib.request, "urlopen", return_value=resp):
            self.assertTrue(h.healthz("http://127.0.0.1:5678"))

    def test_false_on_error(self):
        with mock.patch.object(h.urllib.request, "urlopen",
                               side_effect=Exception("down")):
            self.assertFalse(h.healthz("http://127.0.0.1:5678"))


if __name__ == "__main__":
    unittest.main()
