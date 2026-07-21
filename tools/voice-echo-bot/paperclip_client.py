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
