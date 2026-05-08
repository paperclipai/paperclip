"""Request changes on ZAI-161 via PATCH /api/issues/:id with comment body.

Memory note: encode long bodies as UTF-8 bytes to avoid 500s on the Paperclip API.
"""
import json
import os
import sys
import urllib.request

api_url = os.environ["PAPERCLIP_API_URL"].rstrip("/")
issue_id = os.environ["PAPERCLIP_TASK_ID"]
api_key = os.environ["PAPERCLIP_API_KEY"]
run_id = os.environ["PAPERCLIP_RUN_ID"]

with open("zai161_review_comment.md", "r", encoding="utf-8") as fh:
    comment_md = fh.read()

payload = {
    "status": "in_progress",
    "comment": comment_md,
}
body = json.dumps(payload).encode("utf-8")

req = urllib.request.Request(
    f"{api_url}/api/issues/{issue_id}",
    data=body,
    method="PATCH",
    headers={
        "Authorization": f"Bearer {api_key}",
        "X-Paperclip-Run-Id": run_id,
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": str(len(body)),
    },
)

try:
    with urllib.request.urlopen(req) as resp:
        print(f"status={resp.status}")
        print(resp.read().decode("utf-8")[:1500])
except urllib.error.HTTPError as e:
    print(f"HTTPError {e.code}: {e.reason}", file=sys.stderr)
    print(e.read().decode("utf-8", errors="replace"), file=sys.stderr)
    sys.exit(1)
