import json
import urllib.request

def patch_issue(issue_id, status, comment_body=None):
    base_url = "http://127.0.0.1:3101/api"
    
    if comment_body:
        print(f"Posting comment to issue {issue_id}...")
        comment_url = f"{base_url}/issues/{issue_id}/comments"
        comment_data = json.dumps({"body": comment_body}).encode("utf-8")
        req_comment = urllib.request.Request(
            comment_url,
            data=comment_data,
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        try:
            with urllib.request.urlopen(req_comment) as resp:
                json.loads(resp.read().decode("utf-8"))
                print("Successfully posted comment!")
        except Exception as e:
            print("Error posting comment:", e)
            
    print(f"Marking issue {issue_id} as {status}...")
    issue_url = f"{base_url}/issues/{issue_id}"
    patch_data = json.dumps({"status": status}).encode("utf-8")
    req_patch = urllib.request.Request(
        issue_url,
        data=patch_data,
        headers={"Content-Type": "application/json"},
        method="PATCH"
    )
    try:
        with urllib.request.urlopen(req_patch) as resp:
            json.loads(resp.read().decode("utf-8"))
            print(f"Successfully updated issue status to {status}!")
    except Exception as e:
        print("Error updating issue status:", e)

def main():
    stale_hourly_scans = [
        ("ROC-566", "dd865182-3762-45e2-bbb9-0a03137b6333"),
        ("ROC-564", "62530791-a8af-4f15-b401-92103d7b1ece"),
        ("ROC-560", "51d8932e-f683-4c2b-a123-56f819707eea"),
        ("ROC-537", "58d21cd7-ef74-4575-8fd3-72871122a616"),
        ("ROC-533", "c8b933a0-f07d-45b2-9238-e0091a8bedd5"),
        ("ROC-527", "5ecdad63-6a78-48dc-9fe9-8490a4867733"),
        ("ROC-512", "ccb96ab6-7d6c-40af-8836-eb2234b81877"),
        ("ROC-510", "bb3567f1-d3c5-426d-8ecb-1d74a95a87b4")
    ]
    
    stale_fallback_monitors = [
        ("ROC-509", "cfde204b-8dd1-435b-8350-b38930cd5870"),
        ("ROC-563", "14c14ff7-401a-4651-a991-7be023d7928e"),
        ("ROC-554", "4272fb99-6c81-4ca7-91ae-8d3e3188a04e"),
        ("ROC-536", "96dae4e8-fbb1-4ec8-bf25-4c00eed4d110"),
        ("ROC-535", "397e9e0c-0ae5-4d85-813f-07d845b743fb"),
        ("ROC-496", "57cfb1bb-12a5-4b1b-88a3-56158e739b84")
    ]
    
    print("--- Cleaning up Stale Hourly Scans ---")
    for identifier, uuid in stale_hourly_scans:
        comment = f"Closing stale hourly scan {identifier} as redundant. The latest hourly scan (ROC-568) has been successfully executed and reported."
        patch_issue(uuid, "cancelled", comment)
        
    print("\n--- Cleaning up Stale Fallback Monitors ---")
    for identifier, uuid in stale_fallback_monitors:
        comment = f"Closing stale fallback monitor {identifier}. The decision deadline was May 27, 2026. Fallback (Compressed Option A) has already been successfully triggered and executed on May 27."
        patch_issue(uuid, "done", comment)

if __name__ == "__main__":
    main()
