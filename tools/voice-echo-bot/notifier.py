"""Reine Logik: aus Company-Issues die neuen 'done'/'decision'-Events sammeln."""

def collect_events(issues, label_id, seen):
    events, new_keys = [], []
    for issue in issues:
        iid = issue.get("id")
        if issue.get("parentId") is None and issue.get("status") == "done":
            key = "{}:done".format(iid)
            if key not in seen:
                events.append({"issue": issue, "kind": "done", "key": key})
                new_keys.append(key)
        if label_id and label_id in (issue.get("labelIds") or []):
            key = "{}:decision".format(iid)
            if key not in seen:
                events.append({"issue": issue, "kind": "decision", "key": key})
                new_keys.append(key)
    return events, new_keys
