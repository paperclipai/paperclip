#!/usr/bin/env python3
"""n8n-workflow-watcher.py — Nächtlicher Wächter über aktive n8n-Workflows.

Prüft pro Workflow mit active=1 den jüngsten Lauf im 14-Tage-Fenster und meldet
Walter per mailhub-Mail, wenn dieser Lauf fehlgeschlagen ist (status error/crashed).
Nur-bei-Befund + wöchentliches OK (Montag). Liest ~/.n8n/database.sqlite read-only.
"""
from __future__ import annotations

import argparse
import html
import json
import os
import sqlite3
import sys
import urllib.error
import urllib.request
from datetime import datetime

HOME = os.path.expanduser("~")

# --- Konstanten ---------------------------------------------------------------
N8N_DB = os.path.join(HOME, ".n8n/database.sqlite")
N8N_BASE = "http://localhost:5678"
WINDOW_DAYS = 14
FAIL_STATUSES = {"error", "crashed"}

WEBHOOK_URL = "http://127.0.0.1:5678/webhook/mailhub/send"
MAILHUB_SECRET = "mailhub-812a27b07c73e64d7df192c98a3883eb"
TO_ADDR = "ws@whitestag.ai"
FROM_ADDR = "office@whitestag.ai"

STATE_PATH = os.path.join(HOME, ".paperclip/instances/default/state/n8n-workflow-watcher.json")
LOG_PATH = os.path.join(HOME, ".paperclip/instances/default/logs/n8n-workflow-watcher.log")


# --- Detektion (reine Funktion) ----------------------------------------------
def find_failed_workflows(rows):
    """rows: Iterable[(wf_id, name, mode, status, exec_id, started_at)].
    Gibt Findings zurück, deren status in FAIL_STATUSES liegt."""
    findings = []
    for wf_id, name, mode, status, exec_id, started_at in rows:
        if status in FAIL_STATUSES:
            findings.append({
                "id": wf_id,
                "name": name,
                "mode": mode,
                "exec_id": exec_id,
                "failed_at": started_at,
            })
    return findings


def should_send_heartbeat(today, last_heartbeat_date, has_findings):
    """today: datetime.date. Montag(0) + kein Befund + Heartbeat heute noch nicht
    gesendet → True."""
    if has_findings:
        return False
    if today.weekday() != 0:  # 0 = Montag
        return False
    return last_heartbeat_date != today.isoformat()
