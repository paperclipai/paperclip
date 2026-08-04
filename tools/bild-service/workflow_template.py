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


def fill(raw, prompt, seed, width=0, height=0):
    # json.dumps liefert einen vollstaendig maskierten String samt
    # Anfuehrungszeichen; die schneiden wir ab, weil der Platzhalter in der
    # Vorlage bereits in Anfuehrungszeichen steht.
    prompt_escaped = json.dumps(prompt, ensure_ascii=False)[1:-1]
    # Numerische Platzhalter ZUERST ersetzen, dann __PROMPT__ ZULETZT.
    # Wenn __PROMPT__ zuerst kommt, wird der Prompt-Text anschliessend
    # von den anderen Replacements gescannt, und Literal-Text wie "__SEED__"
    # im Prompt wird versehentlich durch die echten Werte ersetzt.
    filled = (raw
              .replace("__SEED__", str(int(seed)))
              .replace("__WIDTH__", str(int(width)))
              .replace("__HEIGHT__", str(int(height)))
              .replace("__PROMPT__", prompt_escaped))
    return json.loads(filled)


IMAGE_PLACEHOLDERS = ("__IMAGE1__", "__IMAGE2__", "__IMAGE3__")


def _node_refs(node):
    """(Eingangsname, Ziel-Node-ID) fuer alle Verdrahtungen einer Node."""
    out = []
    for key, val in (node.get("inputs") or {}).items():
        if isinstance(val, list) and val and isinstance(val[0], str):
            out.append((key, val[0]))
    return out


def set_images(workflow, names):
    """Quellbilder in die Vorlage setzen und ungenutzte Slots herausschneiden.

    Die Node-IDs stehen bewusst NICHT im Code: welcher Loader zu welchem Slot
    gehoert, sagt allein der Platzhalter. So bleibt die Vorlage in der
    ComfyUI-App umbaubar, ohne dass hier etwas angefasst werden muss.
    """
    if not 1 <= len(names) <= len(IMAGE_PLACEHOLDERS):
        raise ValueError("1 bis %d Quellbilder erwartet, bekommen: %d"
                         % (len(IMAGE_PLACEHOLDERS), len(names)))

    # 1. Genutzte Slots belegen, ungenutzte Loader zum Abriss vormerken.
    tot = set()
    for i, ph in enumerate(IMAGE_PLACEHOLDERS):
        for nid, node in workflow.items():
            if (node.get("inputs") or {}).get("image") != ph:
                continue
            if i < len(names):
                node["inputs"]["image"] = names[i]
            else:
                tot.add(nid)

    # 2. Alles mitreissen, was NUR von abgerissenen Nodes lebt (der Skalierer
    #    hinter einem entfernten Loader haette sonst einen toten Eingang).
    geaendert = True
    while geaendert:
        geaendert = False
        for nid, node in workflow.items():
            if nid in tot:
                continue
            refs = _node_refs(node)
            if refs and all(ziel in tot for _key, ziel in refs):
                tot.add(nid)
                geaendert = True

    # 3. Tote Verdrahtungen aus den Ueberlebenden entfernen. image2/image3 sind
    #    an TextEncodeQwenImageEditPlus optional -- fehlen sie, ist das gueltig.
    for nid, node in workflow.items():
        if nid in tot:
            continue
        for key, ziel in _node_refs(node):
            if ziel in tot:
                del node["inputs"][key]

    for nid in tot:
        del workflow[nid]
    return workflow
