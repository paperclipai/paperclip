"""Tolerantes Extrahieren von Fehlerdetails aus n8n execution_data.data
(JSON-Dedup-Array). Bricht nie ab — bei Unklarheit leere Felder."""
from __future__ import annotations

import json

_EMPTY = {"message": "", "node": "", "http_code": "", "name": "",
          "stack_excerpt": "", "last_node": ""}
_STACK_MAX = 1200


def _find_error_obj(items):
    """Erstes Dict mit 'message' UND ('stack' oder 'name') gilt als Fehlerobjekt."""
    for it in items:
        if isinstance(it, dict) and "message" in it and ("stack" in it or "name" in it):
            return it
    return None


def _find_last_node(items):
    for it in items:
        if isinstance(it, dict) and "lastNodeExecuted" in it:
            v = it["lastNodeExecuted"]
            if isinstance(v, str):
                return v
            if isinstance(v, int) and 0 <= v < len(items) and isinstance(items[v], str):
                return items[v]
    return ""


def extract_error(data_json: str) -> dict:
    out = dict(_EMPTY)
    try:
        items = json.loads(data_json)
    except (ValueError, TypeError):
        return out
    if not isinstance(items, list):
        return out
    err = _find_error_obj(items)
    if err:
        out["message"] = str(err.get("message", ""))
        out["node"] = str(err.get("node", ""))
        out["http_code"] = str(err.get("httpCode", ""))
        out["name"] = str(err.get("name", ""))
        out["stack_excerpt"] = str(err.get("stack", ""))[:_STACK_MAX]
    out["last_node"] = _find_last_node(items) or out["node"]
    return out


def read_execution_error(conn, exec_id) -> dict:
    """Liest execution_data.data für exec_id und extrahiert die Fehlerdetails."""
    row = conn.execute(
        "SELECT data FROM execution_data WHERE executionId = ?", (exec_id,)
    ).fetchone()
    if not row or not row[0]:
        return dict(_EMPTY)
    return extract_error(row[0])
