import json
import os
import tempfile
import unittest

import config


class TestLoadEnv(unittest.TestCase):
    def test_parses_quoted_and_export_lines_ignoring_comments(self):
        with tempfile.NamedTemporaryFile("w", suffix=".env", delete=False) as f:
            f.write('# comment\n')
            f.write('\n')
            f.write('export TELEGRAM_BOT_TOKEN="abc:123"\n')
            f.write('TELEGRAM_ALLOWED_USER_ID="8311805232"\n')
            path = f.name
        self.addCleanup(os.unlink, path)
        env = config.load_env(path)
        self.assertEqual(env["TELEGRAM_BOT_TOKEN"], "abc:123")
        self.assertEqual(env["TELEGRAM_ALLOWED_USER_ID"], "8311805232")
        self.assertNotIn("# comment", env)


class TestLoadToken(unittest.TestCase):
    def test_reads_localhost_3100_token(self):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump({"credentials": {"http://localhost:3100": {"token": "tok-xyz"}}}, f)
            path = f.name
        self.addCleanup(os.unlink, path)
        self.assertEqual(config.load_paperclip_token(path), "tok-xyz")


if __name__ == "__main__":
    unittest.main()
