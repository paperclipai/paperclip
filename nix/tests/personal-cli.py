"""Exercise the Home Manager wrapper with a real Paperclip CLI and loopback API."""

import json
import os
from pathlib import Path
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from urllib.parse import urlparse


client, api_url, company_id, credential_file = sys.argv[1:]
credential = Path(credential_file)
credential.write_text("personal-cli-file-token\n")
credential.chmod(0o600)
requests = []
fixtures = {
    f"/api/companies/{company_id}/issues": [{"id": "fixture-issue"}],
    f"/api/companies/{company_id}/agents": [{"id": "fixture-agent"}],
}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        authorization = self.headers.get("Authorization")
        requests.append((self.path, authorization))
        accepted = (
            self.path in fixtures
            and authorization == "Bearer personal-cli-file-token"
        )
        body = json.dumps(fixtures[self.path] if accepted else {"error": "unauthorized"}).encode()
        self.send_response(200 if accepted else 401)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


address = urlparse(api_url)
server = ThreadingHTTPServer((address.hostname, address.port), Handler)
thread = Thread(target=server.serve_forever)
thread.start()
env = os.environ.copy()
env.update({
    "XDG_CONFIG_HOME": str(Path(env["HOME"]) / ".config"),
    "XDG_CACHE_HOME": str(Path(env["HOME"]) / ".cache"),
    "PAPERCLIP_API_URL": "http://127.0.0.1:1",
    "PAPERCLIP_COMPANY_ID": "wrong-company",
    "PAPERCLIP_API_KEY_FILE": str(credential.with_name("wrong-key")),
    "PAPERCLIP_API_KEY": "wrong-fallback-token",
    "PAPERCLIP_TELEMETRY_DISABLED": "1",
})


def invoke(*command):
    return subprocess.run(
        [client, *(command or ("issue", "list")), "--json"],
        env=env,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        timeout=45,
    )


try:
    response = invoke()
    assert response.returncode == 0, response.stderr
    assert json.loads(response.stdout) == fixtures[f"/api/companies/{company_id}/issues"], response.stdout
    assert requests == [(f"/api/companies/{company_id}/issues", "Bearer personal-cli-file-token")]

    # Agent listing requires an explicit company flag before context resolution.
    agents = invoke("agent", "list", "--company-id", company_id)
    assert agents.returncode == 0, agents.stderr
    assert json.loads(agents.stdout) == fixtures[f"/api/companies/{company_id}/agents"], agents.stdout
    assert requests[-1] == (f"/api/companies/{company_id}/agents", "Bearer personal-cli-file-token")
    assert len(requests) == 2

    # An invalid configured file must not silently use the ambient key.
    credential.chmod(0o644)
    invalid = invoke()
    assert invalid.returncode != 0
    assert "CLI credential file" in invalid.stderr, invalid.stderr
    assert len(requests) == 2, "Publicly readable credential reached the API"
    assert "personal-cli-file-token" not in invalid.stdout + invalid.stderr

    credential.unlink()
    missing = invoke()
    assert missing.returncode != 0
    assert "CLI credential file" in missing.stderr, missing.stderr
    assert len(requests) == 2, "Missing credential fell back to the ambient key"
    assert "personal-cli-file-token" not in missing.stdout + missing.stderr
    print("Paperclip personal CLI: authenticated wrapper, company selection and credential failures passed")
finally:
    server.shutdown()
    server.server_close()
    thread.join()
    credential.unlink(missing_ok=True)
