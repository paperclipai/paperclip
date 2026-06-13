import json
import sqlite3
import unittest
import n8n_execution_error as ee


# Repräsentatives n8n-Dedup-Array (vereinfacht, an Live-Struktur angelehnt):
# - data[2] referenziert error-Index + lastNodeExecuted (String)
# - data[5] ist das Fehlerobjekt
SAMPLE = json.dumps([
    {"resultData": 2},
    {},
    {"error": 5, "runData": 1, "lastNodeExecuted": "OpenAI Chat Model"},
    {},
    {},
    {"level": "error", "name": "NodeApiError",
     "message": "Bad request - please check your parameters",
     "httpCode": "400", "node": "OpenAI Chat Model",
     "stack": "NodeApiError: Bad request\n    at AsyncCaller.onFailedAttempt"},
])


class ExtractError(unittest.TestCase):
    def test_extracts_message_node_httpcode(self):
        out = ee.extract_error(SAMPLE)
        self.assertEqual(out["message"], "Bad request - please check your parameters")
        self.assertEqual(out["node"], "OpenAI Chat Model")
        self.assertEqual(out["http_code"], "400")
        self.assertEqual(out["name"], "NodeApiError")
        self.assertIn("NodeApiError: Bad request", out["stack_excerpt"])

    def test_last_node_executed_string(self):
        out = ee.extract_error(SAMPLE)
        self.assertEqual(out["last_node"], "OpenAI Chat Model")

    def test_garbage_does_not_crash(self):
        out = ee.extract_error("{not valid json")
        self.assertEqual(out["message"], "")
        self.assertEqual(out["node"], "")
        self.assertEqual(out["stack_excerpt"], "")

    def test_empty_array(self):
        out = ee.extract_error("[]")
        self.assertEqual(out["message"], "")

    def test_stack_excerpt_truncated(self):
        big = json.dumps([{"message": "x", "name": "E", "stack": "S" * 5000}])
        out = ee.extract_error(big)
        self.assertLessEqual(len(out["stack_excerpt"]), 1200)


class ReadExecutionError(unittest.TestCase):
    def _db(self):
        conn = sqlite3.connect(":memory:")
        conn.execute("CREATE TABLE execution_data (executionId INT PRIMARY KEY, "
                     "workflowData TEXT, data TEXT, workflowVersionId TEXT)")
        conn.execute("INSERT INTO execution_data VALUES (447224, '{}', ?, 'v1')", (SAMPLE,))
        conn.commit()
        return conn

    def test_reads_and_extracts(self):
        conn = self._db()
        out = ee.read_execution_error(conn, 447224)
        self.assertEqual(out["http_code"], "400")

    def test_missing_execution_returns_empty(self):
        conn = self._db()
        out = ee.read_execution_error(conn, 999999)
        self.assertEqual(out["message"], "")


if __name__ == "__main__":
    unittest.main()
