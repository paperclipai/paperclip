"""Tolerantes Extrahieren von Fehlerdetails aus n8n execution_data.data.

n8n serialisiert execution_data.data als **Dedup-Array**: ein flaches JSON-Array,
in dem String-Werte und Objekte NICHT inline, sondern als String-Index-Pointer auf
andere Array-Elemente gespeichert sind (Zahlen/Booleans stehen inline). Ein Feld
``{"message": "23"}`` bedeutet also: die Nachricht steht an ``items[23]`` — NICHT,
dass die Nachricht "23" ist.

Frueher las dieses Modul die Rohwerte direkt aus und schrieb so Index-Zahlen
(``Node: 7``, ``HTTP 22``, ``message: 23``) in die Fehler-Issues. Jetzt wird jeder
bekannte Fehler-Feldwert genau EINMAL dereferenziert (``items[int(v)]``); das
Ergebnis ist der echte Wert und wird nicht weiter aufgeloest (sonst wuerde ein
echter Wert wie ``"400"`` faelschlich als naechster Index interpretiert).

Bricht nie ab — bei Unklarheit leere Felder."""
from __future__ import annotations

import json

_EMPTY = {"message": "", "node": "", "http_code": "", "name": "",
          "stack_excerpt": "", "last_node": ""}
_STACK_MAX = 1200


def _deref(items, v):
    """Loest einen n8n-Dedup-Pointer um GENAU EINE Ebene auf.

    Pointer sind String- (z.B. ``"23"``) oder Integer-Indizes in das Top-Level-Array.
    Echte Inline-Werte (Nicht-Index-Strings, Floats, Bools, bereits aufgeloeste Dicts)
    werden unveraendert zurueckgegeben. Es wird bewusst nur ein Hop gemacht, damit ein
    echter numerischer Wert (z.B. httpCode ``"400"``) nicht als weiterer Index gilt."""
    idx = None
    if isinstance(v, bool):
        return v
    if isinstance(v, int):
        idx = v
    elif isinstance(v, str) and v.lstrip("-").isdigit():
        idx = int(v)
    if idx is not None and 0 <= idx < len(items):
        return items[idx]
    return v


def _as_text(items, v) -> str:
    r = _deref(items, v)
    return r if isinstance(r, str) else ("" if r is None else str(r))


def _resolve_node_name(items, node_val) -> str:
    """node-Feld kann ein Pointer auf den Namens-String ODER auf das Node-Objekt
    (mit eigenem ``name``-Pointer) sein. Beides abdecken."""
    r = _deref(items, node_val)
    if isinstance(r, dict):
        return _as_text(items, r.get("name", ""))
    return r if isinstance(r, str) else ""


def _combine_message(msg: str, desc: str) -> str:
    """message + description zu einer aussagekraeftigen Zeile vereinen.
    Ist das eine im anderen enthalten (oder eines leer), nur das informativere
    nehmen; sonst beide mit ' — ' verbinden."""
    msg, desc = (msg or "").strip(), (desc or "").strip()
    if not desc:
        return msg
    if not msg:
        return desc
    if desc in msg:
        return msg
    if msg in desc:
        return desc
    return f"{msg} — {desc}"


def _find_error_obj(items):
    """Erstes Dict mit 'message' UND ('stack' oder 'name') gilt als Fehlerobjekt."""
    for it in items:
        if isinstance(it, dict) and "message" in it and ("stack" in it or "name" in it):
            return it
    return None


def _find_last_node(items):
    for it in items:
        if isinstance(it, dict) and "lastNodeExecuted" in it:
            name = _resolve_node_name(items, it["lastNodeExecuted"])
            if name:
                return name
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
        # Die aussagekraeftige Meldung steckt mal in 'description' (z.B. die Telegram-
        # API-Antwort hinter dem generischen 'message'-Wrapper), mal in 'message'
        # selbst (z.B. "connect ECONNREFUSED 127.0.0.1:5432", waehrend 'description'
        # nur "127.0.0.1:5432" ist). Beide kombinieren und Substring-Duplikate kappen.
        desc = _as_text(items, err.get("description", "")) if "description" in err else ""
        msg = _as_text(items, err.get("message", ""))
        out["message"] = _combine_message(msg, desc)
        out["node"] = _resolve_node_name(items, err.get("node", ""))
        out["http_code"] = _as_text(items, err.get("httpCode", ""))
        out["name"] = _as_text(items, err.get("name", ""))
        out["stack_excerpt"] = _as_text(items, err.get("stack", ""))[:_STACK_MAX]
    out["last_node"] = _find_last_node(items) or out["node"]
    return out


def read_execution_error(conn, exec_id) -> dict:
    """Liest execution_data.data fuer exec_id und extrahiert die Fehlerdetails."""
    row = conn.execute(
        "SELECT data FROM execution_data WHERE executionId = ?", (exec_id,)
    ).fetchone()
    if not row or not row[0]:
        return dict(_EMPTY)
    return extract_error(row[0])
