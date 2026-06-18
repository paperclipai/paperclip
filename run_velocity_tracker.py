import sys
import os
import json
import subprocess
import urllib.request
import urllib.error

API_BASE = "http://127.0.0.1:3101/api"
ISSUE_ID = "75523ab6-137c-4efd-b1f3-27db1028b5a6"
RUN_ID = os.environ.get("PAPERCLIP_RUN_ID", "fe421a2c-7bf0-4c0f-8b5f-c857d853c1bf")

def api_request(path, method="GET", data=None):
    url = f"{API_BASE}{path}"
    headers = {
        "Content-Type": "application/json",
        "X-Paperclip-Run-Id": RUN_ID
    }
    req_data = None
    if data is not None:
        req_data = json.dumps(data).encode("utf-8")
    req = urllib.request.Request(url, data=req_data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        print(f"HTTP Error {e.code}: {e.read().decode('utf-8')}")
        sys.exit(1)

def main():
    print("Executing Q3 Velocity Check...")
    # Run the check script
    cmd = ["python3", "/home/dwizy/architect-os/scripts/q3_pipeline_check.py"]
    res = subprocess.run(cmd, capture_output=True, text=True)
    
    print("STDOUT:")
    print(res.stdout)
    print("STDERR:")
    print(res.stderr)
    
    # Read the generated log
    log_path = "/home/dwizy/architect-os/logs/q3-velocity-check.last.log"
    if os.path.exists(log_path):
        with open(log_path, "r") as f:
            report_content = f.read()
    else:
        report_content = res.stdout if res.stdout else "No output from velocity check script."

    # Post comment to Paperclip ROC-548
    comment_body = (
        f"### Q3 Velocity Tracker — Hourly Pipeline Check Run Run\n\n"
        f"```\n{report_content}\n```\n\n"
        f"Execution completed. All metrics are up-to-date."
    )
    
    print("Posting comment to Paperclip issue ROC-548...")
    comment_res = api_request(
        f"/issues/{ISSUE_ID}/comments",
        method="POST",
        data={"body": comment_body}
    )
    print("Comment posted:", comment_res.get("id"))

    # Update issue status to done
    print("Marking issue ROC-548 as done...")
    complete_res = api_request(
        f"/issues/{ISSUE_ID}",
        method="PATCH",
        data={"status": "done"}
    )
    print("Issue status updated to:", complete_res.get("status"))

if __name__ == "__main__":
    main()
