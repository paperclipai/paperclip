import json
import urllib.request

def main():
    issue_id = "28b2be35-93cf-46fe-afc3-d4a3a137525e"
    base_url = "http://127.0.0.1:3101/api"
    
    report_content = """### ✅ Ivan Decision Found & Execution Confirmed (Interval Check)

**Monitoring Checkpoint Summary:**
- **Target Issue Checked:** [ROC-485](/ROC/issues/ROC-485)
- **Ivan's Decision:** Found! Ivan explicitly selected and approved **Option B** (*"Option B approved - Partner Liaison proceed with execution"*) at 2026-05-27 22:48 UTC, prior to the 23:59 UTC fallback activation deadline.
- **Execution Confirmation:** Confirmed. Partner Liaison successfully completed all 5 preliminary DSCR touches ([ROC-331](/ROC/issues/ROC-331) through [ROC-335](/ROC/issues/ROC-335)) as delegated, and formally closed [ROC-485](/ROC/issues/ROC-485) as **done**.
- **Fallback Trigger:** Not needed / cancelled (since the explicit decision was made and executed successfully before the deadline).

With both the decision confirmed and the execution of preliminary touches successfully finished and closed, the monitoring loop for this interval is complete. Marking [ROC-583](/ROC/issues/ROC-583) as **done**."""

    # 1. Post comment
    print(f"Posting comment to issue {issue_id}...")
    comment_url = f"{base_url}/issues/{issue_id}/comments"
    comment_data = json.dumps({"body": report_content}).encode("utf-8")
    
    req_comment = urllib.request.Request(
        comment_url,
        data=comment_data,
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    
    try:
        with urllib.request.urlopen(req_comment) as resp:
            resp_data = json.loads(resp.read().decode("utf-8"))
            print("Successfully posted comment!")
    except Exception as e:
        if hasattr(e, "read"):
            print("Error posting comment:", e.read().decode("utf-8"))
        else:
            print("Error posting comment:", e)
        return

    # 2. Mark issue as done
    print(f"Marking issue {issue_id} as done...")
    issue_url = f"{base_url}/issues/{issue_id}"
    patch_data = json.dumps({"status": "done"}).encode("utf-8")
    
    req_patch = urllib.request.Request(
        issue_url,
        data=patch_data,
        headers={"Content-Type": "application/json"},
        method="PATCH"
    )
    
    try:
        with urllib.request.urlopen(req_patch) as resp:
            resp_data = json.loads(resp.read().decode("utf-8"))
            print("Successfully updated issue status to done!")
    except Exception as e:
        if hasattr(e, "read"):
            print("Error updating issue status:", e.read().decode("utf-8"))
        else:
            print("Error updating issue status:", e)

if __name__ == "__main__":
    main()
