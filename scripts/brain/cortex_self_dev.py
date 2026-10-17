"""
cortex_self_dev.py — Boucle d'auto-développement de Cortex avec garde-fous.

Pipeline :
1. Reçoit un objectif en langage naturel ("ajoute un endpoint X", "fix bug Y")
2. Demande au router v2 de proposer un patch (modèles gratuits d'abord)
3. Parse la proposition (nouveau contenu de fichier ou diff)
4. Crée une branche cortex/dev/<timestamp>-<slug>
5. Applique le patch
6. Lance test_smoke complet
7. Si tests passent → commit, sinon arrêt pour inspection

Le LLM ne touche JAMAIS le disque directement. Tout passe par cortex_tools
qui valide les chemins, et toute modif est isolée dans une branche git éphémère.
"""
try:
    from lmstudio_response import extract_lmstudio_content
except Exception:
    from scripts.brain.lmstudio_response import extract_lmstudio_content
try:
    from lmstudio_policy import add_lmstudio_ttl, get_lmstudio_config, select_lmstudio_model
except Exception:
    from scripts.brain.lmstudio_policy import add_lmstudio_ttl, get_lmstudio_config, select_lmstudio_model
import datetime as dt
import json
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

REPO_ROOT      = Path(r"H:\Code\Paperclip")
ROUTER_URL     = "http://127.0.0.1:18900/route_v2"
LM_STUDIO_URL  = get_lmstudio_config()["base_url"] + "/v1"
SELFDEV_LOG    = REPO_ROOT / ".cortex-self-dev.log"
GUARDRAILS_FILE = REPO_ROOT / "scripts" / "brain" / "cortex_self_dev_guardrails.json"

DEFAULT_GUARDRAILS = {
    "enabled": True,
    "allowed_path_prefixes": ["scripts/brain/"],
    "blocked_path_fragments": [
        ".env", "secrets", "cookies", "token", "password", ".venv",
        "node_modules", ".git"
    ],
    "max_context_chars": 4200,
    "max_files_per_change": 2,
    "max_shrink_ratio": 0.55,
    "require_explicit_path_in_goal": True,
    "valid_tests": ["router", "serve", "memory", "tts", "cortex"],
    "test_aliases": {"voice": "tts", "self_dev": "cortex", "identity": "cortex"},
    "commit_only_applied_files": True,
    "auto_apply_risk_threshold": "low"
}


def _load_guardrails() -> dict:
    if not GUARDRAILS_FILE.exists():
        GUARDRAILS_FILE.write_text(
            json.dumps(DEFAULT_GUARDRAILS, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        return dict(DEFAULT_GUARDRAILS)
    try:
        data = json.loads(GUARDRAILS_FILE.read_text(encoding="utf-8"))
        merged = dict(DEFAULT_GUARDRAILS)
        merged.update(data if isinstance(data, dict) else {})
        return merged
    except Exception:
        return dict(DEFAULT_GUARDRAILS)

# Import des tools sûrs
sys.path.insert(0, str(REPO_ROOT / "scripts" / "brain"))
import cortex_tools as ct


def _log(msg: str):
    line = f"[{dt.datetime.now().isoformat(timespec='seconds')}] {msg}"
    print(line, flush=True)
    try:
        with open(SELFDEV_LOG, "a", encoding="utf-8") as f: f.write(line + "\n")
    except Exception: pass


def _slugify(text: str, max_len: int = 30) -> str:
    s = re.sub(r'[^\w\s-]', '', text.lower())
    s = re.sub(r'[-\s]+', '-', s).strip('-')
    return s[:max_len] or "task"


# ─── Génération du patch via router v2 ───────────────────────────────────────
PROPOSAL_PROMPT = """Tu es Cortex, un assistant de développement Python qui peut modifier son propre code.

Objectif demandé par Sam :
{goal}

Contexte (fichiers pertinents) :
{context}

Format de réponse OBLIGATOIRE — uniquement un bloc JSON, rien d'autre :
{{
  "analysis": "explication courte du diagnostic et de l'approche",
  "files": [
    {{"path": "chemin/relatif/au/repo/fichier.py", "content": "CONTENU COMPLET DU FICHIER (pas un diff)"}}
  ],
  "tests": ["tts", "router", "memory"]
}}

Règles strictes :
- Tous les chemins sont relatifs à H:\\Code\\Paperclip
- "content" doit être le fichier COMPLET (on remplace, pas un patch)
- "tests" liste les suites smoke à lancer (router|serve|memory|tts|cortex) — au minimum les zones touchées
- Préserve l'encodage UTF-8 et les apostrophes françaises
- N'ajoute aucune dépendance externe sans justification
- Garde la cohérence avec le code existant (style, imports)

Réponds UNIQUEMENT avec le JSON, sans markdown."""


def _gather_context(goal: str, max_files: int = 2, max_chars_per_file: int = 3000,
                    total_budget: int = 7000) -> str:
    """Grep mots-clés du goal, retourne fichiers pertinents tronqués pour rester
    sous total_budget chars (les free models digèrent mal au-delà de ~10K)."""
    keywords = [w for w in re.findall(r'\w{4,}', goal) if w.lower() not in
                {"dans", "pour", "avec", "tous", "comme", "doit", "code", "file",
                 "fichier", "ajouter", "ajoute", "ajout"}][:4]
    if not keywords: return ""

    relevant_files = {}
    # Priorité absolue aux chemins explicitement cités par Sam / Cortex.
    for raw_path in re.findall(r'(?:scripts|packages|server|ui|doc|docs)[\w./\\-]+\.\w+', goal):
        rel = raw_path.replace("\\", "/")
        if (REPO_ROOT / rel).exists():
            relevant_files[rel] = 100
    for kw in keywords:
        r = ct.search(kw, "scripts", max_results=8)
        for m in r.get("matches", []):
            relevant_files[m["file"]] = relevant_files.get(m["file"], 0) + 1

    top_files = sorted(relevant_files.items(), key=lambda x: -x[1])[:max_files]
    parts, total = [], 0
    for fname, _hits in top_files:
        budget = min(max_chars_per_file, total_budget - total)
        if budget < 500: break
        f = ct.read_file(str(REPO_ROOT / fname), max_bytes=budget)
        if f.get("ok"):
            block = f"### {fname}\n```python\n{f['content']}\n```"
            parts.append(block)
            total += len(block)
    return "\n\n".join(parts) if parts else "(pas de contexte trouvé)"


def _normalize_tests(tests, files) -> list[str]:
    guardrails = _load_guardrails()
    valid = set(guardrails.get("valid_tests", DEFAULT_GUARDRAILS["valid_tests"]))
    aliases = guardrails.get("test_aliases", DEFAULT_GUARDRAILS["test_aliases"])
    out = []
    for t in tests or []:
        key = aliases.get(str(t), str(t))
        if key in valid and key not in out:
            out.append(key)
    touched = " ".join(files or [])
    if "scripts/brain/" in touched and "cortex" not in out:
        out.append("cortex")
    return out or ["cortex"]


def _ask_router(prompt: str, timeout: int = 240) -> dict:
    """Pose la question au router v2, retourne le JSON parsé du modèle."""
    try:
        payload = json.dumps({"text": prompt, "role": "code"}).encode("utf-8")
        req = urllib.request.Request(ROUTER_URL, data=payload,
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode())
    except Exception as e:
        return {"error": str(e)}


def _ask_lm_studio_direct(prompt: str, timeout: int = 180) -> dict:
    """Fallback direct quand le router v2 retourne inject=True.

    Le self-dev a besoin d'une réponse modèle structurée. Un résultat
    {"inject": true, "text": prompt} signifie seulement "à envoyer à Claude",
    pas "patch proposé". On utilise alors le modèle local chargé dans LM Studio.
    """
    try:
      with urllib.request.urlopen(f"{LM_STUDIO_URL}/models", timeout=5) as r:
          models = json.loads(r.read().decode()).get("data", [])
      model = select_lmstudio_model(
          task_type="complex_self_dev",
          requested_model=os.environ.get("SELF_DEV_MODEL", get_lmstudio_config()["deep_model"]),
          automatic=True,
          available_models=[m.get("id", "") for m in models],
      )
      payload = {
          "model": model,
          "messages": [
            {"role": "system", "content": "/no_think\nOutput only the final answer. No hidden reasoning. No markdown unless explicitly requested."},
            {"role": "user", "content": "/no_think\n" + prompt},
        ],
          "temperature": 0.1,
          "max_tokens": 6000,
          "stream": False,
      }
      payload = json.dumps(add_lmstudio_ttl(payload)).encode("utf-8")
      req = urllib.request.Request(
          f"{LM_STUDIO_URL}/chat/completions",
          data=payload,
          headers={"Content-Type": "application/json"},
      )
      with urllib.request.urlopen(req, timeout=timeout) as r:
          d = json.loads(r.read().decode())
      content = extract_lmstudio_content(d["choices"][0], expect_json=True)
      return {"backend": f"lm_studio:{model}", "response": content}
    except Exception as e:
      return {"error": str(e)}


def _parse_proposal(response_text: str) -> dict | None:
    """Extrait le JSON de la réponse modèle (peut contenir du texte autour)."""
    if not response_text: return None
    # Cherche un bloc JSON {...}
    for m in re.finditer(r'\{[\s\S]*\}', response_text):
        candidate = m.group(0)
        try:
            d = json.loads(candidate)
            if isinstance(d, dict) and "files" in d:
                return d
        except json.JSONDecodeError: continue
    return None


def _parse_goal_proposal(response_text: str) -> dict | None:
    """Extrait le JSON court {goal,rationale,risk} de la boucle autonome."""
    if not response_text:
        return None
    for m in re.finditer(r'\{[\s\S]*\}', response_text):
        try:
            d = json.loads(m.group(0))
        except json.JSONDecodeError:
            continue
        if isinstance(d, dict) and d.get("goal"):
            return d
    return None


# ─── Application sécurisée ──────────────────────────────────────────────────
def propose_and_apply(goal: str, dry_run: bool = False) -> dict:
    """Boucle complète : propose → branche → applique → test → commit ou inspection.
    Retourne un rapport structuré."""
    started = time.time()
    report = {"goal": goal, "started_at": dt.datetime.now().isoformat(),
              "steps": [], "outcome": "pending"}

    def step(name, **data):
        entry = {"name": name, "ts": time.time() - started, **data}
        report["steps"].append(entry)
        _log(f"  step: {name} {data}")

    _log(f"=== self_dev: {goal[:80]} ===")
    guardrails = _load_guardrails()
    report["guardrails_file"] = str(GUARDRAILS_FILE)
    if not guardrails.get("enabled", True):
        report["outcome"] = "guardrails_disabled"
        step("guardrails_disabled")
        return report

    # 1. Récupérer contexte pertinent
    context = _gather_context(goal, max_files=int(guardrails.get("max_files_per_change", 2)),
                              max_chars_per_file=1800,
                              total_budget=int(guardrails.get("max_context_chars", 4200)))
    step("context_gathered", chars=len(context))

    # 2. Demander une proposition au router v2
    prompt = PROPOSAL_PROMPT.format(goal=goal, context=context)
    rv = _ask_router(prompt)
    if "error" in rv:
        report["outcome"] = "router_error"
        report["error"] = rv["error"]
        step("router_failed", error=rv["error"])
        return report
    if rv.get("inject") and not rv.get("response"):
        step("router_inject_only", backend=rv.get("backend"))
        rv = _ask_lm_studio_direct(prompt)
        if "error" in rv:
            report["outcome"] = "model_unavailable"
            report["error"] = rv["error"]
            step("lm_studio_failed", error=rv["error"])
            return report
    raw = rv.get("response") or rv.get("text") or ""
    backend = rv.get("backend", "?")
    step("proposal_received", backend=backend, chars=len(raw))

    # 3. Parser le JSON
    proposal = _parse_proposal(raw)
    if not proposal:
        report["outcome"] = "parse_failed"
        report["raw_excerpt"] = raw[:500]
        step("parse_failed", excerpt=raw[:200])
        return report
    files = proposal.get("files", [])
    tests = _normalize_tests(proposal.get("tests", ["router", "serve", "memory"]),
                             [f.get("path", "") for f in files])
    report["analysis"] = proposal.get("analysis", "")
    report["files_planned"] = [f.get("path") for f in files]
    step("proposal_parsed", files=len(files), tests=tests)

    if guardrails.get("require_explicit_path_in_goal", True):
        explicit_paths = set(p.replace("\\", "/") for p in re.findall(r'(?:scripts|packages|server|ui|doc|docs)[\w./\\-]+\.\w+', goal))
        planned_paths = set(str(f.get("path", "")).replace("\\", "/") for f in files)
        if not planned_paths or not planned_paths.issubset(explicit_paths):
            report["outcome"] = "guardrail_refused"
            step("guardrail_refused", reason="planned paths are not explicitly named in goal",
                 planned=list(planned_paths), explicit=list(explicit_paths))
            return report

    if dry_run:
        report["outcome"] = "dry_run"
        return report

    # 4. Créer branche dédiée
    branch = f"cortex/dev/{dt.datetime.now().strftime('%Y%m%d-%H%M%S')}-{_slugify(goal)}"
    br = ct.git_branch(branch)
    if not br.get("ok"):
        report["outcome"] = "branch_failed"
        step("branch_failed", err=br.get("stderr"))
        return report
    step("branch_created", branch=branch)

    # 5. Appliquer les modifications
    applied = []
    for f in files:
        path = f.get("path")
        content = f.get("content", "")
        if not path or not content:
            continue
        norm_path = path.replace("\\", "/")
        allowed = guardrails.get("allowed_path_prefixes", [])
        blocked = guardrails.get("blocked_path_fragments", [])
        if allowed and not any(norm_path.startswith(p) for p in allowed):
            step("write_refused", path=path, reason="outside allowed_path_prefixes")
            continue
        if any(b.lower() in norm_path.lower() for b in blocked):
            step("write_refused", path=path, reason="blocked_path_fragments")
            continue
        # Vérification chemin sûr
        try:
            full_path = REPO_ROOT / path
            ct._safe_path(str(full_path))
        except PermissionError as e:
            step("write_refused", path=path, reason=str(e))
            continue
        if full_path.exists():
            old_size = full_path.stat().st_size
            shrink = float(guardrails.get("max_shrink_ratio", 0.55))
            if old_size > 1000 and len(content.encode("utf-8")) < old_size * shrink:
                step("write_refused", path=path,
                     reason=f"proposal would shrink existing file from {old_size} to {len(content.encode('utf-8'))} bytes")
                continue
        w = ct.write_file(str(full_path), content)
        if w.get("ok"):
            applied.append(path)
            step("file_written", path=path, size=w.get("size"))
        else:
            step("write_failed", path=path, error=w.get("error"))
    report["files_applied"] = applied
    if not applied:
        report["outcome"] = "no_files_applied"
        step("stopped_for_review", reason="no file passed guardrails")
        return report

    # 6. Lancer les tests smoke
    test_results = {}
    all_pass = True
    for suite in tests:
        sm = ct.run_smoke(suite, timeout=240)
        test_results[suite] = sm
        step("smoke_run", suite=suite, ok=sm.get("ok"),
             passed=sm.get("passed"), total=sm.get("total"))
        if not sm.get("ok"):
            all_pass = False
    report["tests"] = test_results

    # 7. Commit ou rollback
    if all_pass:
        cm = ct.git_commit_paths(f"Cortex self-dev: {goal[:60]}", applied,
                                 only_if_smoke_passes=False)
        if cm.get("ok"):
            report["outcome"] = "applied"
            step("committed", branch=branch)
            # Mémorise sémantiquement la compétence acquise (modulaire, indexée
            # automatiquement dans le graphe → rappel par retrieve_context la
            # prochaine fois qu'un goal sémantiquement proche arrive).
            try:
                import cortex_learned_skills as _cls
                short_name = goal.strip()[:60].rstrip(".:")
                rem = _cls.remember(name=short_name, goal=goal,
                                    outcome="applied",
                                    applied_files=applied,
                                    tests=test_results,
                                    tags=["self_dev", "applied"])
                step("skill_remembered", ok=rem.get("ok"), path=rem.get("path"),
                     slug=rem.get("slug"))
            except Exception as _ee:
                step("skill_remember_failed", error=str(_ee))
        else:
            report["outcome"] = "commit_failed"
            step("commit_failed", error=cm.get("stderr"))
    else:
        report["outcome"] = "tests_failed_left_for_review"
        step("stopped_for_review", reason="smoke tests failed", files=applied)

    report["duration_s"] = round(time.time() - started, 1)
    _log(f"=== self_dev: outcome={report['outcome']} ({report['duration_s']}s) ===")
    return report


# ─── Auto-génération de goals : boucle de curiosité ─────────────────────────
CURIOSITY_PROMPT = """Tu es Cortex, en train d'analyser ton propre fonctionnement.

Voici les statistiques de ton router v2 sur les 50 derniers échanges :
{stats}

Voici les 3 derniers échecs notables (smoke tests, parse errors, escalades vers Claude) :
{failures}

Ton objectif : proposer UN seul micro-objectif d'amélioration concret et testable.
Le but est de réduire un échec récurrent OU augmenter ta robustesse OU améliorer la qualité.

Format obligatoire — UNIQUEMENT JSON :
{{
  "goal": "description d'une seule action concrète (ex: 'ajouter un timeout configurable dans X', 'fix typo dans Y')",
  "rationale": "pourquoi ce changement aide",
  "risk": "low" ou "medium"
}}

Privilégie les tâches "low" risk pour une boucle automatique. Réponds UNIQUEMENT avec le JSON."""


def _read_recent_failures() -> str:
    """Scanne le log self-dev récent pour collecter les échecs."""
    if not SELFDEV_LOG.exists(): return "(aucun échec récent)"
    try:
        lines = SELFDEV_LOG.read_text(encoding="utf-8", errors="replace").splitlines()[-200:]
        failures = [l for l in lines if any(w in l.lower() for w in
                    ["fail", "error", "rolled_back", "rollback", "exception"])][-5:]
        return "\n".join(failures) if failures else "(aucun échec dans les logs récents)"
    except Exception:
        return "(impossible de lire les logs)"


def _read_v2_stats() -> str:
    try:
        with urllib.request.urlopen("http://127.0.0.1:18900/v2_state", timeout=3) as r:
            d = json.loads(r.read().decode())
        lines = [f"threshold={d.get('threshold')}"]
        for k, v in d.get("models", {}).items():
            lines.append(f"  {k}: priority={v['priority']:.2f}, wins={v['wins']}/{v['calls']}, "
                         f"avg_lat={v.get('avg_latency', 0):.1f}s, "
                         f"cooldown={v.get('in_cooldown')}")
        return "\n".join(lines)
    except Exception as e:
        return f"(stats unavailable: {e})"


def autonomous_iteration(risk_threshold: str = "low") -> dict:
    """Une itération autonome : génère un goal, le filtre par risque, applique.
    Retourne le rapport. risk_threshold: 'low' refuse medium/high."""
    _log("=== autonomous iteration start ===")
    stats = _read_v2_stats()
    failures = _read_recent_failures()
    prompt = CURIOSITY_PROMPT.format(stats=stats, failures=failures)
    rv = _ask_router(prompt)
    raw = rv.get("response") or rv.get("text") or ""
    proposal = _parse_goal_proposal(raw) or {}
    goal = proposal.get("goal", "")
    risk = proposal.get("risk", "medium")
    if not goal:
        return {"outcome": "no_goal_generated", "raw": raw[:300]}
    if risk_threshold == "low" and risk != "low":
        return {"outcome": "risk_too_high", "goal": goal, "risk": risk,
                "rationale": proposal.get("rationale")}
    _log(f"  autonomous goal: {goal} (risk={risk})")
    return propose_and_apply(goal, dry_run=False)


# ─── CLI ─────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if len(sys.argv) < 2:
        print("Usage:\n  cortex_self_dev.py '<goal>' [--dry-run]\n  cortex_self_dev.py --autonomous [low|medium]")
        sys.exit(1)
    if sys.argv[1] == "--autonomous":
        risk = sys.argv[2] if len(sys.argv) > 2 else "low"
        rep = autonomous_iteration(risk_threshold=risk)
    else:
        goal = sys.argv[1]
        dry = "--dry-run" in sys.argv
        rep = propose_and_apply(goal, dry_run=dry)
    print("\n=== RAPPORT ===")
    print(json.dumps(rep, ensure_ascii=False, indent=2)[:5000])
