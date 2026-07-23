#!/usr/bin/env python3
"""Runnable stdlib self-check for audit_logs.py."""

from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


with tempfile.TemporaryDirectory() as temp:
    root = Path(temp)
    (root / "sites" / "alpha").mkdir(parents=True)
    (root / "sites" / "beta").mkdir(parents=True)
    logs = root / ".wpdev" / "ols-docker" / "logs"
    write(
        logs / "alpha-error.log",
        "2026-07-21 01:00:00.000000 [NOTICE] [1] [STDERR] PHP Warning:  Broken value in "
        + str(root)
        + "/plugins/example.php on line 42\n"
        "2026-07-21 01:01:00.000000 [NOTICE] [1] [STDERR] PHP Warning:  Broken value in "
        + str(root)
        + "/plugins/example.php on line 99\n"
        "2026-07-21 01:01:30.000000 [NOTICE] [1] [STDERR] PHP Warning: request token=log-secret Authorization: Bearer abc123 in "
        + str(root)
        + "/plugins/secret.php on line 5\n"
        "2026-07-21 01:01:40.000000 [NOTICE] [1] [STDERR] PHP Warning: request failed at "
        "https://example.test/check?_wpnonce=nonce-value&access_token=token-value&api_key=key-value"
        "&password=password-value&cookie=cookie-value&authorization=authorization-value in "
        + str(root)
        + "/plugins/query-secret.php on line 6\n"
        "2026-07-21 01:01:50.000000 [NOTICE] [1] [STDERR] PHP Warning: request failed at "
        "https://user:embedded-password@example.test/check?access%5Ftoken=encoded-secret&ok=1;_wpnonce=semicolon-secret in "
        + str(root)
        + "/plugins/encoded-query-secret.php on line 7\n"
        "2026-07-21 01:01:55.000000 [NOTICE] [1] [STDERR] PHP Warning: request failed at "
        "https://example.test/check#access_token=fragment-secret&ok=1 in "
        + str(root)
        + "/plugins/fragment.php on line 8\n"
        "2026-07-21 01:01:57.000000 [NOTICE] [1] [STDERR] PHP Warning: request body {\"token\":\"json-secret\",\"nested\":{\"password\":\"nested-secret\"}} in "
        + str(root)
        + "/plugins/json.php on line 9\n"
        "2026-07-21 01:01:58.000000 [NOTICE] [1] [STDERR] PHP Warning: request body {\"token\":broken-secret in "
        + str(root)
        + "/plugins/malformed-json.php on line 10\n"
        "PHP Warning: undated historical error token=undated-secret\n",
    )
    write(
        logs / "alpha-access.log",
        '127.0.0.1 - - [21/Jul/2026:01:02:00 +0000] "GET /wp-json/jobs/123?_wpnonce=secret&post_id=456 HTTP/2" 500 10 "-" "test"\n'
        '127.0.0.1 - - [21/Jul/2026:01:02:10 +0000] "GET http://[broken HTTP/2" 502 10 "-" "test"\n'
        '127.0.0.1 - - [21/Jul/2026:01:02:20 +0000] "GET /after-malformed?access_token=still-secret HTTP/2" 503 10 "-" "test"\n'
        '127.0.0.1 - - [21/Jul/2026:01:02:30 +0000] "GET /reset/token/path-secret HTTP/2" 504 10 "-" "test"\n'
        '127.0.0.1 - - [21/Jul/2026:01:02:40 +0000] "GET /webhook/secret/secret-value/123 HTTP/2" 505 10 "-" "test"\n',
    )
    write(
        root / "sites" / "beta" / "wp-content" / "debug.log",
        "[21-Jul-2026 01:03:00 UTC] PHP Fatal error:  Boom in " + str(root) + "/plugins/beta.php on line 7\n",
    )
    output = subprocess.check_output(
        ["python3", str(HERE / "audit_logs.py"), "--root", str(root)],
        text=True,
    )
    report = json.loads(output)
    assert report["sites"] == ["alpha", "beta"], report["sites"]
    warning = next(event for event in report["events"] if "Broken value" in event["signature"])
    assert warning["count"] == 2, warning
    assert "<workspace>/plugins/example.php" in warning["signature"], warning
    request = next(event for event in report["events"] if event["severity"] == "500")
    assert request["severity"] == "500", request
    assert "secret" not in request["signature"], request
    assert "%3Credacted%3E" in request["signature"], request
    assert "/<id>" in request["signature"] and "post_id=%3Cid%3E" in request["signature"], request
    access_file = next(item for item in report["files"] if item["kind"] == "access")
    assert access_file["first_timestamp"] == "2026-07-21T01:02:00Z", access_file
    secret_warning = next(event for event in report["events"] if "plugins/secret.php" in event["signature"])
    assert "log-secret" not in secret_warning["signature"] and "abc123" not in secret_warning["signature"], secret_warning
    assert secret_warning["signature"].count("<redacted>") == 2, secret_warning
    query_warning = next(event for event in report["events"] if "plugins/query-secret.php" in event["signature"])
    for leaked in ("nonce-value", "token-value", "key-value", "password-value", "cookie-value", "authorization-value"):
        assert leaked not in query_warning["signature"], query_warning
    assert query_warning["signature"].count("<redacted>") == 6, query_warning
    encoded_query_warning = next(event for event in report["events"] if "plugins/encoded-query-secret.php" in event["signature"])
    for leaked in ("user", "embedded-password", "encoded-secret", "semicolon-secret"):
        assert leaked not in encoded_query_warning["signature"], encoded_query_warning
    assert encoded_query_warning["signature"].count("<redacted>") == 3, encoded_query_warning
    fragment_warning = next(event for event in report["events"] if "plugins/fragment.php" in event["signature"])
    assert "fragment-secret" not in fragment_warning["signature"] and "access_token=<redacted>" in fragment_warning["signature"], fragment_warning
    json_warning = next(event for event in report["events"] if "plugins/json.php" in event["signature"])
    assert "json-secret" not in json_warning["signature"] and "nested-secret" not in json_warning["signature"], json_warning
    assert json_warning["signature"].count("<redacted>") == 2, json_warning
    malformed_json = next(event for event in report["events"] if "request body <redacted>" in event["signature"])
    assert "broken-secret" not in malformed_json["signature"] and "<redacted>" in malformed_json["signature"], malformed_json
    malformed = next(event for event in report["events"] if event["severity"] == "502")
    assert malformed["signature"] == "GET <malformed-target> -> HTTP 502", malformed
    after_malformed = next(event for event in report["events"] if event["severity"] == "503")
    assert "still-secret" not in after_malformed["signature"] and "%3Credacted%3E" in after_malformed["signature"], after_malformed
    path_secret = next(event for event in report["events"] if event["severity"] == "504")
    assert "path-secret" not in path_secret["signature"] and "/token/<redacted>" in path_secret["signature"], path_secret
    nested_path_secret = next(event for event in report["events"] if event["severity"] == "505")
    assert "secret-value" not in nested_path_secret["signature"], nested_path_secret
    assert "/secret/<redacted>/<id>" in nested_path_secret["signature"], nested_path_secret
    fatal = next(event for event in report["events"] if event["severity"] == "fatal")
    assert fatal["site"] == "beta", fatal
    filtered = json.loads(
        subprocess.check_output(
            [
                "python3",
                str(HERE / "audit_logs.py"),
                "--root",
                str(root),
                "--since",
                "2026-07-21T01:02:50Z",
            ],
            text=True,
        )
    )
    assert not any(event["kind"] == "http" for event in filtered["events"]), filtered["events"]
    assert len(filtered["events"]) == 1 and filtered["events"][0]["severity"] == "fatal", filtered["events"]

print("site-log-audit self-check: PASS")
