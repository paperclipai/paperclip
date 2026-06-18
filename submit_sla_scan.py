import json
import urllib.request

def main():
    issue_id = "a87039c7-2622-4640-ac12-63a114383cb2"
    base_url = "http://127.0.0.1:3101/api"
    
    # Read the compiled report
    with open("sla_scan_report.md", "r") as f:
        report_content = f.read()
        
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
