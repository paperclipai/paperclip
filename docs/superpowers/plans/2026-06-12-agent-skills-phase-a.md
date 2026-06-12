# Agent-Skills Phase A — Audit & Zuweisung — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Jeden WHITESTAG-Agenten per Skills-Sync-API auf seinen Matrix-Zielsatz bringen (zweistufiges Modell), reversibel und verifiziert.

**Architecture:** Ein eigenständiges Python-Ops-Skript (`scripts/skill-matrix/sync.py`) mit den Modi `--backup`, `--validate`, `--dry-run`, `--apply`, `--verify`. Die Zielmatrix und die Tier-Baselines sind als Daten im Skript hinterlegt. Reine Logik (Diff-Berechnung, Ref-Auflösung) wird mit pytest unit-getestet; die API-Interaktion wird über die Live-Modi gegen die laufende Control-Plane verifiziert.

**Tech Stack:** Python 3.9 (stdlib: `urllib`, `json`, `argparse`, `datetime`), pytest für die reinen Funktionen, `curl`/Control-Plane-API unter `http://localhost:3100`.

**Vorbedingungen:**
- Control-Plane läuft auf `http://localhost:3100`.
- Board-Token in Env `PCP_TOKEN` (aus `~/.paperclip/auth.json`, Feld `credentials["http://localhost:3100"].token`).
- Company-ID `9cebf3cf-efe8-4597-a400-f06488900a87` (Env `PCP_CID`).

**Offener Bestätigungspunkt:** DPO war im Spec in keiner Tier-Liste. Default hier: Tier 1, Ziel = Tier-1-Baseline (= Ist-Zustand, No-op). Vor `--apply` kurz bestätigen lassen.

---

## File Structure

- Create: `scripts/skill-matrix/sync.py` — das Ops-Skript (alle Modi, Matrix-Daten).
- Create: `scripts/skill-matrix/test_sync.py` — pytest für die reinen Funktionen.
- Create (zur Laufzeit): `scripts/skill-matrix/backups/desiredSkills-<timestamp>.json` — Backup.
- Read-only: bestehende Agenten-Configs via API.

---

## Task 1: Skript-Gerüst mit Matrix-Daten

**Files:**
- Create: `scripts/skill-matrix/sync.py`

- [ ] **Step 1: Skript mit Konstanten, Matrix und Argparse anlegen**

```python
#!/usr/bin/env python3
"""WHITESTAG Agent-Skill-Matrix Sync (Phase A)."""
import argparse, json, os, sys, urllib.request, urllib.error
from datetime import datetime

API = os.environ.get("PCP_API", "http://localhost:3100")
CID = os.environ.get("PCP_CID", "9cebf3cf-efe8-4597-a400-f06488900a87")
TOKEN = os.environ.get("PCP_TOKEN", "")

TIER1_BASELINE = ["paperclip", "para-memory-files", "paperclip-create-agent",
                  "paperclip-create-plugin", "online-recherche",
                  "whitestag-brand", "whitestag-dsgvo"]
TIER2_BASELINE = ["paperclip", "para-memory-files", "whitestag-dsgvo"]
BRAND = ["whitestag-brand"]  # nur fuer output-/kundenseitige Tier-2-Rollen (⭐)

# agent-id -> (anzeigename, ziel-slug-liste)
MATRIX = {
    # --- Tier 1 ---
    "506c873e-3a40-4483-9a45-0eb0fa1554bb": ("CEO",
        TIER1_BASELINE + ["whitestag-angebot", "vermoegen-overview", "vr-produktion-pipeline"]),
    "5b7cb8a7-945f-4861-b3a7-4ae84d242d1e": ("CTO",
        TIER1_BASELINE + ["whitestag-n8n-workflow", "paperclip-dev", "diagnose-why-work-stopped"]),
    "408f7e88-1ab6-4c9a-988b-68040fd28c13": ("CFO",
        TIER1_BASELINE + ["vermoegen-overview", "vermoegen-aktien", "vermoegen-etf",
                          "vermoegen-gold", "buchhaltung-euer", "buchhaltung-einkommensteuer",
                          "whitestag-angebot"]),
    "bbf38291-1129-43db-97de-c03c998b691e": ("CMO",
        TIER1_BASELINE + ["copywriting", "marketing-ideas", "marketing-psychology",
                          "social-content", "newsletter-redaktion", "newsletter-scoring"]),
    "d4bdef1a-84fb-4393-8491-0eeaebcb3270": ("CPO",
        TIER1_BASELINE + ["whitestag-n8n-workflow", "web-design-guidelines"]),
    "aa036cf5-0af7-4ed1-b04e-c7a54f71e553": ("CRO", list(TIER1_BASELINE)),
    "5563514c-4254-48d5-9339-802172304119": ("VP Engineering",
        TIER1_BASELINE + ["whitestag-n8n-workflow", "paperclip-dev", "diagnose-why-work-stopped"]),
    "4920b0be-b197-45ae-a169-54b99082c4ea": ("Creative Director",
        TIER1_BASELINE + ["vr-produktion-pipeline", "drehbuch-vr", "adobe-automation",
                          "mistika-vr-pipeline"]),
    "790bcaf2-83d8-4e04-8c43-914a96db7bd8": ("DPO", list(TIER1_BASELINE)),  # spec-luecke, no-op default
    # --- Tier 2 ---
    "358a70ad-927e-499f-85fe-d823d16d76a4": ("Adobe",
        TIER2_BASELINE + BRAND + ["adobe-automation", "vr-produktion-pipeline"]),
    "f4bf1c83-9c79-4864-87eb-dd8c22fa604d": ("Bild & Video",
        TIER2_BASELINE + BRAND + ["adobe-automation", "vr-produktion-pipeline"]),
    "8d8ab6da-d527-408d-b78f-de16a265c4ee": ("Blender",
        TIER2_BASELINE + ["blender-scripting", "vr-produktion-pipeline"]),
    "c73aceb3-63a5-4927-bff4-c595b408cd83": ("Buchhaltung",
        TIER2_BASELINE + ["buchhaltung-euer", "buchhaltung-einkommensteuer"]),
    "478fad75-48b1-4248-9dc5-5f3980a961fd": ("Drehbuch",
        TIER2_BASELINE + BRAND + ["drehbuch-vr", "vr-produktion-pipeline"]),
    "ea38630c-5da8-4719-8e4a-1f0478c4bc40": ("Marken-Spezialist",
        TIER2_BASELINE + BRAND + ["copywriting", "marketing-psychology"]),
    "56f7167b-b594-4533-9243-411947306907": ("Mistika VR",
        TIER2_BASELINE + ["mistika-vr-pipeline", "vr-produktion-pipeline"]),
    "d80fe6b9-b2ac-4d58-8525-8bbbb1d0caf7": ("Online-Rechercheur",
        TIER2_BASELINE + ["online-recherche"]),
    "6d595481-8cbb-49bf-8ffb-8685c071d557": ("Produktentwicklung",
        TIER2_BASELINE + ["whitestag-n8n-workflow", "vr-produktion-pipeline"]),
    "410a78b9-8472-4503-8232-0ff97bafa2f8": ("Social Media",
        TIER2_BASELINE + BRAND + ["social-content", "copywriting", "marketing-psychology"]),
    "605c7900-c6f7-4fb3-9bed-1fcd36fcfdca": ("Web-Design",
        TIER2_BASELINE + BRAND + ["web-design-guidelines"]),
    "6bbbfe93-7fa8-44cb-8e21-23e81a9bb4dd": ("Vermoegensverwaltung",
        TIER2_BASELINE + ["vermoegen-overview", "vermoegen-aktien", "vermoegen-etf", "vermoegen-gold"]),
    "3067ea1d-5050-4032-aff5-1f759f544160": ("Vault-Maintainer", list(TIER2_BASELINE)),
    "e24b8d9d-143e-4141-b413-4361aa618771": ("Sekretaerin",
        TIER2_BASELINE + BRAND + ["pdf", "whitestag-angebot"]),
    "caaeb345-9db1-41ab-95a3-115d3c70cf34": ("Link-Detektor",
        ["paperclip", "para-memory-files"]),
    # HomePod-Test-Agent (3fcd92d8-...) bleibt bewusst unangetastet.
}


def api_get(path):
    req = urllib.request.Request(API + path, headers={"Authorization": "Bearer " + TOKEN})
    return json.load(urllib.request.urlopen(req))


def api_post(path, body):
    data = json.dumps(body).encode()
    req = urllib.request.Request(API + path, data=data, method="POST",
        headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req))


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--print-matrix", action="store_true")
    p.add_argument("--backup", action="store_true")
    p.add_argument("--validate", action="store_true")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--apply", action="store_true")
    p.add_argument("--verify", action="store_true")
    args = p.parse_args()
    if args.print_matrix:
        for aid, (nm, slugs) in MATRIX.items():
            print(f"{nm:22} ({len(slugs)}): {', '.join(slugs)}")
        return
    print("Kein Modus gewaehlt. Siehe --help.", file=sys.stderr)


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Matrix-Ausgabe prüfen**

Run: `cd "$PWD" && python3 scripts/skill-matrix/sync.py --print-matrix`
Expected: 24 Zeilen (8 Tier1 inkl. DPO + 15 Tier2 + … = 24 Agenten; HomePod fehlt bewusst). Jede Zeile zeigt Name, Skill-Anzahl, Slugs. Keine Exception.

- [ ] **Step 3: Commit**

```bash
git add scripts/skill-matrix/sync.py
git commit -m "feat(skill-matrix): Skript-Geruest + Phase-A-Zielmatrix"
```

---

## Task 2: Reine Logik (Diff + Ref-Auflösung) testgetrieben

**Files:**
- Create: `scripts/skill-matrix/test_sync.py`
- Modify: `scripts/skill-matrix/sync.py`

- [ ] **Step 1: Failing test schreiben**

```python
# scripts/skill-matrix/test_sync.py
import sync

def test_compute_diff_add_and_remove():
    cur = ["paperclip", "online-recherche", "comfyui-flux"]
    tgt = ["paperclip", "whitestag-brand"]
    add, remove = sync.compute_diff(cur, tgt)
    assert add == ["whitestag-brand"]
    assert sorted(remove) == ["comfyui-flux", "online-recherche"]

def test_resolve_prefers_existing_ref():
    refmap = {"whitestag-brand": "local/abc123/whitestag-brand"}
    installed = {"copywriting"}
    assert sync.resolve("whitestag-brand", refmap, installed) == "local/abc123/whitestag-brand"
    # installierter Company-Skill ohne vorhandene Ref -> reiner Slug
    assert sync.resolve("copywriting", refmap, installed) == "copywriting"

def test_resolve_unknown_raises():
    try:
        sync.resolve("does-not-exist", {}, set())
        assert False, "sollte werfen"
    except ValueError:
        pass
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag bestätigen**

Run: `cd scripts/skill-matrix && python3 -m pytest test_sync.py -v`
Expected: FAIL — `AttributeError: module 'sync' has no attribute 'compute_diff'`.

- [ ] **Step 3: Funktionen implementieren** (in `sync.py` oberhalb von `main()` einfügen)

```python
def compute_diff(current, target):
    """Gibt (hinzuzufuegen, zu_entfernen) auf Slug-Basis zurueck, Reihenfolge stabil."""
    cur_slugs = [r.split("/")[-1] for r in current]
    add = [s for s in target if s not in cur_slugs]
    remove = [s for s in cur_slugs if s not in target]
    return add, remove


def resolve(slug, refmap, installed):
    """Slug -> kanonische Ref: vorhandene Ref bevorzugen, sonst reiner Slug wenn installiert."""
    if slug in refmap:
        return refmap[slug]
    if slug in installed:
        return slug
    raise ValueError("nicht aufloesbar: " + slug)
```

- [ ] **Step 4: Test laufen lassen, Erfolg bestätigen**

Run: `cd scripts/skill-matrix && python3 -m pytest test_sync.py -v`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add scripts/skill-matrix/sync.py scripts/skill-matrix/test_sync.py
git commit -m "feat(skill-matrix): compute_diff + resolve mit Tests"
```

---

## Task 3: Backup aller aktuellen Zuweisungen

**Files:**
- Modify: `scripts/skill-matrix/sync.py`

- [ ] **Step 1: Backup-Funktion + Modus implementieren** (in `main()` vor dem "Kein Modus"-Print ergänzen, Funktion oberhalb)

```python
def load_agents():
    d = api_get(f"/api/companies/{CID}/agents")
    return d if isinstance(d, list) else d.get("agents", [])


def current_skills(agent):
    ac = agent.get("adapterConfig") or {}
    return ((ac.get("paperclipSkillSync") or {}).get("desiredSkills")) or []


def do_backup():
    agents = load_agents()
    snap = {a["id"]: {"name": a.get("name"), "desiredSkills": current_skills(a)} for a in agents}
    os.makedirs(os.path.join(os.path.dirname(__file__), "backups"), exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    path = os.path.join(os.path.dirname(__file__), "backups", f"desiredSkills-{stamp}.json")
    with open(path, "w") as f:
        json.dump(snap, f, indent=2, ensure_ascii=False)
    print(f"Backup: {path} ({len(snap)} Agenten)")
    return path
```

Und in `main()` ergänzen (vor dem Schluss-Print):

```python
    if args.backup:
        do_backup(); return
```

- [ ] **Step 2: Backup ausführen**

Run: `cd "$PWD" && python3 scripts/skill-matrix/sync.py --backup`
Expected: `Backup: …/backups/desiredSkills-<stamp>.json (25 Agenten)`. Datei existiert und enthält 25 Einträge.

- [ ] **Step 3: Commit (Skript + Backup)**

```bash
git add scripts/skill-matrix/sync.py scripts/skill-matrix/backups/
git commit -m "feat(skill-matrix): Backup-Modus + erstes Backup"
```

---

## Task 4: Resolution-Map bauen & alle Targets validieren

**Files:**
- Modify: `scripts/skill-matrix/sync.py`

- [ ] **Step 1: Map-Aufbau + Validate-Modus implementieren**

```python
def build_refmap_and_installed():
    """refmap: slug -> vorhandene kanonische Ref (aus allen Agenten geharvestet).
       installed: Slugs der installierten Company-Skills."""
    agents = load_agents()
    refmap = {}
    for a in agents:
        for r in current_skills(a):
            refmap.setdefault(r.split("/")[-1], r)
    sk = api_get(f"/api/companies/{CID}/skills")
    sk = sk if isinstance(sk, list) else sk.get("skills", [])
    installed = {s.get("slug") for s in sk}
    return refmap, installed


def do_validate():
    refmap, installed = build_refmap_and_installed()
    missing = []
    for aid, (nm, slugs) in MATRIX.items():
        for s in slugs:
            try:
                resolve(s, refmap, installed)
            except ValueError:
                missing.append((nm, s))
    if missing:
        for nm, s in missing:
            print(f"NICHT AUFLOESBAR: {nm} -> {s}")
        sys.exit(1)
    print(f"OK: alle {sum(len(v[1]) for v in MATRIX.values())} Zuweisungen aufloesbar")
```

In `main()`:

```python
    if args.validate:
        do_validate(); return
```

- [ ] **Step 2: Validieren**

Run: `cd "$PWD" && python3 scripts/skill-matrix/sync.py --validate`
Expected: `OK: alle <N> Zuweisungen aufloesbar`, Exit 0. Keine `NICHT AUFLOESBAR`-Zeile.

- [ ] **Step 3: Commit**

```bash
git add scripts/skill-matrix/sync.py
git commit -m "feat(skill-matrix): Validate-Modus (Ref-Aufloesung)"
```

---

## Task 5: Dry-Run-Diff pro Agent

**Files:**
- Modify: `scripts/skill-matrix/sync.py`

- [ ] **Step 1: Dry-Run-Modus implementieren**

```python
def do_dry_run():
    agents = {a["id"]: a for a in load_agents()}
    for aid, (nm, target) in MATRIX.items():
        cur = current_skills(agents[aid])
        add, remove = compute_diff(cur, target)
        if not add and not remove:
            print(f"= {nm}: keine Aenderung")
            continue
        print(f"~ {nm}:")
        for s in add:    print(f"    + {s}")
        for s in remove: print(f"    - {s}")
```

In `main()`:

```python
    if args.dry_run:
        do_dry_run(); return
```

- [ ] **Step 2: Dry-Run ausführen und Diff prüfen**

Run: `cd "$PWD" && python3 scripts/skill-matrix/sync.py --dry-run`
Expected: Pro Agent die geplanten `+`/`-`-Zeilen. Sichtkontrolle: u. a. `Adobe: - comfyui-flux`, `Adobe: - online-recherche`; die 8 zuvor leeren Agenten (CRO, Creative Director, Bild & Video, Buchhaltung, Drehbuch, Marken-Spezialist, Online-Rechercheur, Social Media, Web-Design) zeigen viele `+`; `DPO: keine Aenderung`.

- [ ] **Step 3: Commit**

```bash
git add scripts/skill-matrix/sync.py
git commit -m "feat(skill-matrix): Dry-Run-Diff"
```

---

## Task 6: Apply (Tier 1 zuerst, dann Tier 2)

**Files:**
- Modify: `scripts/skill-matrix/sync.py`

> **STOP vor diesem Task:** Den DPO-Default (Tier-1-Baseline, No-op) und den Dry-Run-Output vom Nutzer freigeben lassen, bevor `--apply` läuft.

- [ ] **Step 1: Apply-Modus implementieren** (Targets werden vor dem Senden zu Refs aufgelöst)

```python
TIER1_IDS = ["506c873e-3a40-4483-9a45-0eb0fa1554bb", "5b7cb8a7-945f-4861-b3a7-4ae84d242d1e",
             "408f7e88-1ab6-4c9a-988b-68040fd28c13", "bbf38291-1129-43db-97de-c03c998b691e",
             "d4bdef1a-84fb-4393-8491-0eeaebcb3270", "aa036cf5-0af7-4ed1-b04e-c7a54f71e553",
             "5563514c-4254-48d5-9339-802172304119", "4920b0be-b197-45ae-a169-54b99082c4ea",
             "790bcaf2-83d8-4e04-8c43-914a96db7bd8"]


def do_apply():
    refmap, installed = build_refmap_and_installed()
    order = TIER1_IDS + [a for a in MATRIX if a not in TIER1_IDS]
    for aid in order:
        nm, target = MATRIX[aid]
        refs = [resolve(s, refmap, installed) for s in target]
        try:
            api_post(f"/api/agents/{aid}/skills/sync", {"desiredSkills": refs})
            print(f"OK  {nm}: {len(refs)} Skills gesynct")
        except urllib.error.HTTPError as e:
            print(f"ERR {nm}: HTTP {e.code} {e.read().decode()[:200]}")
```

In `main()`:

```python
    if args.apply:
        do_apply(); return
```

- [ ] **Step 2: Backup sicherstellen, dann Apply ausführen**

Run: `cd "$PWD" && python3 scripts/skill-matrix/sync.py --backup && python3 scripts/skill-matrix/sync.py --apply`
Expected: Für jeden der 24 Agenten eine `OK <Name>: <n> Skills gesynct`-Zeile, keine `ERR`-Zeile.

- [ ] **Step 3: Commit**

```bash
git add scripts/skill-matrix/sync.py scripts/skill-matrix/backups/
git commit -m "feat(skill-matrix): Apply-Modus (Tier1 vor Tier2)"
```

---

## Task 7: Verify-Endzustand

**Files:**
- Modify: `scripts/skill-matrix/sync.py`

- [ ] **Step 1: Verify-Modus implementieren**

```python
def do_verify():
    agents = {a["id"]: a for a in load_agents()}
    ok = True
    for aid, (nm, target) in MATRIX.items():
        cur_slugs = sorted({r.split("/")[-1] for r in current_skills(agents[aid])})
        want = sorted(set(target))
        if cur_slugs != want:
            ok = False
            print(f"ABWEICHUNG {nm}:")
            print(f"   ist:  {cur_slugs}")
            print(f"   soll: {want}")
        if "comfyui-flux" in cur_slugs:
            ok = False; print(f"PHANTOM {nm}: comfyui-flux noch vorhanden")
    print("VERIFY OK" if ok else "VERIFY FEHLGESCHLAGEN")
    sys.exit(0 if ok else 1)
```

In `main()`:

```python
    if args.verify:
        do_verify(); return
```

- [ ] **Step 2: Verify ausführen**

Run: `cd "$PWD" && python3 scripts/skill-matrix/sync.py --verify`
Expected: `VERIFY OK`, Exit 0. Keine `ABWEICHUNG`- oder `PHANTOM`-Zeile.

- [ ] **Step 3: Gegenprobe Dashboard (kein Agent mit 0 Skills außer HomePod)**

Run:
```bash
curl -s -H "Authorization: Bearer $PCP_TOKEN" \
  "http://localhost:3100/api/companies/$PCP_CID/agents" \
| python3 -c "import sys,json; ags=json.load(sys.stdin); ags=ags if isinstance(ags,list) else ags.get('agents',[]); \
[print(a['name']) for a in ags if not ((a.get('adapterConfig') or {}).get('paperclipSkillSync') or {}).get('desiredSkills')]"
```
Expected: Nur `HomePod-Test-Agent` (sonst leer).

- [ ] **Step 4: Commit**

```bash
git add scripts/skill-matrix/sync.py
git commit -m "feat(skill-matrix): Verify-Modus + Phase-A-Abschluss"
```

---

## Self-Review (vom Autor ausgefüllt)

- **Spec-Abdeckung:** Tiers (Task 1 MATRIX), Baselines (TIER1/TIER2_BASELINE), Lücken-Fixes
  (8 leere Agenten erhalten Sätze), Bereinigung (compute_diff entfernt comfyui-flux/Infra-Skills),
  Backup (Task 3), Diff-Preview (Task 5), Apply Tier1→Tier2 (Task 6), Verify inkl. Phantom-Check
  (Task 7). Newsletter→CMO in MATRIX. DPO-Spec-Lücke explizit als Bestätigungspunkt markiert.
- **Platzhalter:** keine; alle Schritte enthalten echten Code/echte Befehle.
- **Typ-Konsistenz:** `compute_diff`, `resolve`, `current_skills`, `load_agents`,
  `build_refmap_and_installed`, `api_get`, `api_post` über alle Tasks identisch benannt/signiert.

## Rollback

Bei Bedarf den Endzustand mit dem Backup rückgängig machen: ein kleiner Loop, der pro Agent
`{"desiredSkills": <backup[aid].desiredSkills>}` an `/api/agents/{aid}/skills/sync` POSTet
(Refs aus dem Backup sind bereits kanonisch).
