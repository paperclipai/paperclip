"""Workflow-Vorlagen im ComfyUI-API-Format laden und Platzhalter ersetzen.

Platzhalter statt fester Node-IDs: so kann eine Vorlage in der Desktop-App
umgebaut und neu exportiert werden, ohne dass hier Code angefasst wird.
"""
import json
import os

PLACEHOLDERS = ("__PROMPT__", "__SEED__", "__WIDTH__", "__HEIGHT__")

WORKFLOW_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "workflows")


def load_raw(name):
    path = os.path.join(WORKFLOW_DIR, name + ".api.json")
    with open(path, encoding="utf-8") as f:
        return f.read()


def fill(raw, prompt, seed, width, height):
    # json.dumps liefert einen vollstaendig maskierten String samt
    # Anfuehrungszeichen; die schneiden wir ab, weil der Platzhalter in der
    # Vorlage bereits in Anfuehrungszeichen steht.
    prompt_escaped = json.dumps(prompt, ensure_ascii=False)[1:-1]
    filled = (raw
              .replace("__PROMPT__", prompt_escaped)
              .replace("__SEED__", str(int(seed)))
              .replace("__WIDTH__", str(int(width)))
              .replace("__HEIGHT__", str(int(height))))
    return json.loads(filled)
