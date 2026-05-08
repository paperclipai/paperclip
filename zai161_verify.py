import json, os, sys, urllib.request

api_url = os.environ["PAPERCLIP_API_URL"].rstrip("/")
issue_id = os.environ["PAPERCLIP_TASK_ID"]
api_key = os.environ["PAPERCLIP_API_KEY"]

req = urllib.request.Request(
    f"{api_url}/api/issues/{issue_id}",
    method="GET",
    headers={"Authorization": f"Bearer {api_key}", "Accept": "application/json"},
)
with urllib.request.urlopen(req) as resp:
    data = json.loads(resp.read().decode("utf-8"))

issue = data.get("issue") or data
keys_of_interest = [
    "id", "identifier", "status", "assigneeAgentId", "assigneeUserId",
]
out = {k: issue.get(k) for k in keys_of_interest}
exec_state = issue.get("executionState") or {}
out["executionState"] = {
    "currentStageType": exec_state.get("currentStageType"),
    "currentParticipant": exec_state.get("currentParticipant"),
    "returnAssignee": exec_state.get("returnAssignee"),
    "lastDecisionOutcome": exec_state.get("lastDecisionOutcome"),
}
sys.stdout.buffer.write(json.dumps(out, indent=2, ensure_ascii=False).encode("utf-8"))
