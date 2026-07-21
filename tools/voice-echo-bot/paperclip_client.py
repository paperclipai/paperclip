"""Paperclip-Issue-Erzeugung für den Voice-Echo-Bot."""
import json
import re
import urllib.request

from config import API_BASE


def derive_title(text, max_len=80):
    text = (text or "").strip()
    if not text:
        return "Sprachnotiz"
    # erste Zeile
    first = text.splitlines()[0].strip()
    # erster Satz (bis zum ersten . ! ? gefolgt von Space/Ende)
    match = re.search(r"^(.*?[.!?])(\s|$)", first)
    candidate = match.group(1).strip() if match else first
    if len(candidate) > max_len:
        candidate = candidate[:max_len].rstrip() + "…"
    return candidate


def create_issue(token, company_id, assignee_agent_id, title, description):
    url = "{}/companies/{}/issues".format(API_BASE, company_id)
    body = {
        "title": title,
        "description": description,
        "assigneeAgentId": assignee_agent_id,
        "priority": "medium",
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer {}".format(token),
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _get_json(token, path):
    req = urllib.request.Request(API_BASE + path, headers={"Authorization": "Bearer {}".format(token)})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _unwrap(data):
    if isinstance(data, list):
        return data
    return data.get("issues", data.get("data", data.get("labels", [])))


def list_issues(token, company_id, label_id=None, assignee_agent_id=None):
    params = []
    if label_id:
        params.append("labelId={}".format(label_id))
    if assignee_agent_id:
        params.append("assigneeAgentId={}".format(assignee_agent_id))
    path = "/companies/{}/issues".format(company_id)
    if params:
        path += "?" + "&".join(params)
    return _unwrap(_get_json(token, path))


def resolve_label_id(token, company_id, name):
    for label in _unwrap(_get_json(token, "/companies/{}/labels".format(company_id))):
        if label.get("name") == name:
            return label.get("id")
    return None


def find_issue_by_identifier(token, company_id, identifier, assignee_agent_id=None):
    for issue in list_issues(token, company_id, assignee_agent_id=assignee_agent_id):
        if issue.get("identifier") == identifier:
            return issue
    return None


def add_comment(token, issue_id, body, resume=True):
    payload = {"body": body}
    if resume:
        payload["resume"] = True
    req = urllib.request.Request(
        "{}/issues/{}/comments".format(API_BASE, issue_id),
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": "Bearer {}".format(token)},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))
