import sys
import json
import urllib.request
import urllib.error
import os

# Setup parameters
api_base = "http://127.0.0.1:3101/api"
company_id = "5c2551e8-cb65-4ab4-9fee-8e0001be2e41"
agent_id = "b50e08fc-a014-4f3b-8b62-4a9e475f5cef"
run_id = os.environ.get("PAPERCLIP_RUN_ID", "fb6cbbba-a5ec-4a55-ab80-bd47f9ddc3aa")
issue_id_roc340 = "29f947e8-42c8-4424-abc4-80bf9f01ddd2"

def api_request(path, method="GET", data=None, headers=None):
    url = f"{api_base}{path}"
    if headers is None:
        headers = {}
    headers["Content-Type"] = "application/json"
    headers["X-Paperclip-Run-Id"] = run_id
    
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

# Step 1: Checkout ROC-340
print("Checking out ROC-340...")
checkout_res = api_request(
    f"/issues/{issue_id_roc340}/checkout",
    method="POST",
    data={
        "agentId": agent_id,
        "expectedStatuses": ["blocked", "todo"]
    }
)
print("Checkout response:", checkout_res)

# Step 2: Create the Q3 Velocity Plan ticket
print("Creating Q3 Velocity Plan ticket...")
description = """# Q3 Funded-Loan Velocity Plan

Based on Q2 2026 baseline performance, this ticket outlines the Q3 2026 Funded-Loan Velocity Plan and ratchet target.

## (a) Baseline Funded-Count (Q2 2026)
As reported during the Q2 review, the baseline funded-loan count stands at:
- **Cumulative Q2 Baseline:** **6 units** (excluding Q1 overlapping closed loans)
  - Ivan Duarte: **3 units**
  - Yauvan Kumar: **2 units**
  - Michael Simpson: **1 unit**
  - Zunaira Asghar: **0 units**
  
*Note: If including March 31 closes, the baseline is **7 units** (Ivan: 1, Yauvan: 3, Michael: 1, Zunaira: 0, Unattributed: 2).*

---

## (b) +30% Target Lift (Q3 2026)
To satisfy the ratchet goal, the Q3 target is established as:
- **Baseline = 6 units:** Target is **8 units** (calculated as 7.8 units, rounded up)
- **Baseline = 7 units:** Target is **10 units** (calculated as 9.1 units, rounded up)

---

## (c) Per-AE Quotas (Ivan/Yauvan/Michael/Zunaira per canonical roster)
To distribute ownership across the canonical AE roster, the following quotas are assigned:

| Account Executive | Q2 Baseline (Units) | Q3 Quota (Baseline 6) | Q3 Quota (Baseline 7) |
|---|:---:|:---:|:---:|
| **Ivan Duarte** | 3 | 4 | 4 |
| **Yauvan Kumar** | 2 | 2 | 3 |
| **Michael Simpson** | 1 | 1 | 2 |
| **Zunaira Asghar (Zee)** | 0 | 1 | 1 |
| **Total Target** | **6 / 7** | **8 units** | **10 units** |

---

## (d) Weekly Friday Review Cadence Reaffirmation
We hereby reaffirm the weekly Friday review cadence where CEO Ops compares each week's actual funded counts against:
- Median weekly closed count from the final Q2 series
- Same-week prior year production
- Same-week prior quarter production

Intervention flags (such as the under-median flag rule) will trigger pipeline-intervention subtasks for Lead Operations if any AE falls behind targets for 2+ consecutive weeks.
"""

new_issue = api_request(
    f"/companies/{company_id}/issues",
    method="POST",
    data={
        "title": "[OPS] Q3 Funded-Loan Velocity Plan & Quotas",
        "description": description,
        "status": "todo",
        "priority": "high",
        "parentId": issue_id_roc340
    }
)
print("Created Issue ID:", new_issue["id"], "Identifier:", new_issue["identifier"])

# Step 3: Add comment to ROC-340 referencing the new ticket
comment_body = f"I have successfully filed the Q3 Funded-Loan Velocity Plan based on the Q2 baseline. The plan ticket is now open under issue [{new_issue['identifier']}](/ROC/issues/{new_issue['identifier']}) with final target definitions, AE-level quotas, and cadence reaffirmations."
print("Commenting on ROC-340...")
comment_res = api_request(
    f"/issues/{issue_id_roc340}/comments",
    method="POST",
    data={
        "body": comment_body
    }
)
print("Comment posted:", comment_res["id"])

# Step 4: Mark ROC-340 as done
print("Completing ROC-340...")
complete_res = api_request(
    f"/issues/{issue_id_roc340}",
    method="PATCH",
    data={
        "status": "done"
    }
)
print("ROC-340 marked as done:", complete_res["status"])
