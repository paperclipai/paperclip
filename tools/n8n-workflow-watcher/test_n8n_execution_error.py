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


# ECHTES n8n-Dedup-Array (an Live-Execution 458395 angelehnt): Fehler-Feldwerte sind
# String-Index-POINTER ins Top-Level-Array, nicht Inline-Strings. 'node' zeigt auf ein
# Node-Objekt mit eigenem 'name'-Pointer; 'description' traegt die aussagekraeftige
# Meldung hinter dem generischen 'message'. Frueher schrieb der Detektor hier die rohen
# Indizes (Node: 7, HTTP 22, message: 23) in die Issues — dieser Test deckt das ab.
# Array programmatisch aufgebaut, damit Pointer-Ziele exakt an ihren Indizes liegen.
def _build_dedup():
    arr = ["n/a"] * 25
    arr[0] = {"resultData": 2}
    arr[2] = {"error": 5, "lastNodeExecuted": "7"}      # lastNodeExecuted -> Pointer
    arr[5] = {"level": "error", "name": "19", "message": "23",
              "description": "16", "httpCode": "22", "node": "20", "stack": "24"}
    arr[7] = "Telegram Send Digest"
    arr[16] = ("Bad Request: can't parse entities: "
               "Can't find end tag corresponding to start tag \"b\"")
    arr[19] = "NodeApiError"
    arr[20] = {"name": "7", "type": "x"}                # Node-Objekt -> name -> 7
    arr[22] = "400"
    arr[23] = "Bad request - please check your parameters"
    arr[24] = "NodeApiError: Bad request\n    at ExecuteContext.apiRequest"
    return json.dumps(arr)


DEDUP = _build_dedup()


class ExtractError(unittest.TestCase):
    def test_extracts_message_node_httpcode(self):
        out = ee.extract_error(SAMPLE)
        self.assertEqual(out["message"], "Bad request - please check your parameters")
        self.assertEqual(out["node"], "OpenAI Chat Model")
        self.assertEqual(out["http_code"], "400")
        self.assertEqual(out["name"], "NodeApiError")
        self.assertIn("NodeApiError: Bad request", out["stack_excerpt"])

    def test_dedup_pointers_are_resolved(self):
        """Regression: Index-Pointer muessen aufgeloest werden, nicht als Rohzahl landen."""
        out = ee.extract_error(DEDUP)
        self.assertEqual(out["node"], "Telegram Send Digest")
        self.assertEqual(out["http_code"], "400")
        self.assertEqual(out["name"], "NodeApiError")
        self.assertEqual(out["last_node"], "Telegram Send Digest")
        # message kombiniert generischen Wrapper + aussagekraeftige description
        self.assertIn("can't parse entities", out["message"])
        self.assertIn("Bad request - please check your parameters", out["message"])
        # kein roher Index mehr
        self.assertNotIn(out["node"], ("7", "20"))
        self.assertNotEqual(out["http_code"], "22")

    def test_combine_message_dedups_substring(self):
        # message == description -> nicht doppeln
        same = json.dumps([{"message": "Boom", "description": "Boom", "name": "E", "stack": "s"}])
        self.assertEqual(ee.extract_error(same)["message"], "Boom")
        # description Substring von message -> nur message
        sub = json.dumps([{"message": "connect ECONNREFUSED 127.0.0.1:5432",
                           "description": "127.0.0.1:5432", "name": "E", "stack": "s"}])
        self.assertEqual(ee.extract_error(sub)["message"], "connect ECONNREFUSED 127.0.0.1:5432")

    def test_httpcode_not_over_resolved(self):
        # '400' darf nach einem Hop NICHT als weiterer Index gelten
        out = ee.extract_error(DEDUP)
        self.assertEqual(out["http_code"], "400")

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
