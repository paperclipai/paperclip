"""
llm_router.py — Router LLM intelligent.
Reçoit les requêtes et les route vers le bon modèle selon la disponibilité.

Port : 19000
API : POST /route  {"text": "...", "context": "voice|code|analysis"}
GET  /status       → modèle actif, usage, backends disponibles

Backends prioritaires :
  1. Claude (Max) — via VS Code inject
  2. GPT-4/5     — via OpenAI API (si clé dispo)
  3. qwen local  — via LM Studio (http://localhost:1234)
  4. ollama      — via http://localhost:11434
"""
try:
    from lmstudio_response import extract_lmstudio_content
except Exception:
    from scripts.brain.lmstudio_response import extract_lmstudio_content
try:
    from lmstudio_policy import add_lmstudio_ttl, get_lmstudio_config, select_lmstudio_model
except Exception:
    from scripts.brain.lmstudio_policy import add_lmstudio_ttl, get_lmstudio_config, select_lmstudio_model
import json, os, re, socket, sys, time, threading, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

_LOCK = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
try:
    _LOCK.bind(("127.0.0.1", 19000))
except OSError:
    print("[llm_router] déjà en cours — quitte.")
    sys.exit(0)

PORT         = 18900

MODEL_INFO = {
    "claude":           {"name": "Claude Sonnet 4.6", "cost": "Max sub",   "iq": 90, "type": "subscription"},
    "codex":            {"name": "GPT-5.5",           "cost": "OAI sub",   "iq": 95, "type": "subscription"},
    "lm_studio":        {"name": "qwen3.6-35b",       "cost": "free/local","iq": 72, "type": "local"},
    "ollama":            {"name": "Ollama local",       "cost": "free/local","iq": 65, "type": "local"},
    "big_pickle":       {"name": "Big Pickle",        "cost": "free",      "iq": 70, "type": "opencode"},
    "minimax_m2.5":     {"name": "Minimax M2.5",      "cost": "free",      "iq": 75, "type": "opencode"},
    "gpt_5_nano":       {"name": "GPT-5 nano",        "cost": "free",      "iq": 65, "type": "opencode"},
    "hy3_preview":      {"name": "HY3 Preview",       "cost": "free",      "iq": 70, "type": "opencode"},
    "nemotron_3_super": {"name": "Nemotron 3 Super",  "cost": "free",      "iq": 75, "type": "opencode"},
}
VAULT        = Path(r"C:\Users\Smedj\Documents\Obsidian Vault")
COOKIES_FILE = Path.home() / ".claude" / ".claude-cookies.json"
ORG_UUID     = "952c1bc7-5fd1-4f7c-83db-a020932db2ab"
LM_STUDIO    = get_lmstudio_config()["base_url"]
OLLAMA       = "http://localhost:11434"

# ─── État global ──────────────────────────────────────────────────────────────
_state = {
    "active_backend": "claude",
    "usage": {},
    "backends": {},
    "request_count": 0,
    "last_route": None,
}
_lock = threading.Lock()


# ─── Sonde backends ───────────────────────────────────────────────────────────
def probe_claude_usage() -> dict:
    """Lit le quota Claude Max."""
    try:
        cookies = json.loads(COOKIES_FILE.read_text()) if COOKIES_FILE.exists() else {}
        sk = cookies.get("sessionKey", "")
        if not sk:
            return {}
        req = urllib.request.Request(
            f"https://claude.ai/api/organizations/{ORG_UUID}/usage",
            headers={"Cookie": f"sessionKey={sk}", "User-Agent": "Mozilla/5.0",
                     "Accept": "application/json", "Referer": "https://claude.ai/settings/usage",
                     "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors"}
        )
        with urllib.request.urlopen(req, timeout=6) as r:
            return json.loads(r.read().decode())
    except Exception:
        return {}


def probe_lm_studio() -> dict:
    """Vérifie si LM Studio est accessible et quel modèle est chargé."""
    try:
        req = urllib.request.Request(f"{LM_STUDIO}/v1/models")
        with urllib.request.urlopen(req, timeout=2) as r:
            d = json.loads(r.read().decode())
            models = [m["id"] for m in d.get("data", [])]
            return {"available": True, "models": models}
    except Exception:
        return {"available": False, "models": []}


def probe_ollama() -> dict:
    """Vérifie si Ollama est accessible."""
    try:
        req = urllib.request.Request(f"{OLLAMA}/api/tags")
        with urllib.request.urlopen(req, timeout=2) as r:
            d = json.loads(r.read().decode())
            models = [m["name"] for m in d.get("models", [])]
            return {"available": True, "models": models}
    except Exception:
        return {"available": False, "models": []}


def probe_codex() -> dict:
    """Vérifie si Codex CLI est disponible."""
    import shutil
    if shutil.which("codex"):
        return {"available": True, "model": "gpt-5.5", "type": "subscription"}
    return {"available": False}


_claude_rate_limited = False   # True dès qu'une erreur rate-limit est reçue
_rate_limit_until    = 0.0     # timestamp de fin de blocage estimé

def report_rate_limit(backend: str, reset_seconds: int = 3600):
    """Appelé quand Claude retourne une erreur 429/rate-limit."""
    global _claude_rate_limited, _rate_limit_until
    if backend == "claude":
        _claude_rate_limited = True
        _rate_limit_until = time.time() + reset_seconds
        print(f"[router] ⚠ Claude rate-limité — switch automatique", flush=True)

def decide_backend(usage: dict) -> str:
    """Claude jusqu'à l'erreur réelle, puis Codex, puis qwen."""
    global _claude_rate_limited, _rate_limit_until

    # Lever le flag si le délai est passé
    if _claude_rate_limited and time.time() > _rate_limit_until:
        _claude_rate_limited = False
        print("[router] Claude rate-limit expiré — retour Claude", flush=True)

    if not _claude_rate_limited:
        return "claude"

    # Claude bloqué → modèles gratuits OpenCode d'abord (benchmark: big_pickle > minimax > codex)
    for model_id in ["big_pickle", "minimax_m2.5", "gpt_5_nano", "hy3_preview", "nemotron_3_super"]:
        m = _state["backends"].get(model_id, {})
        if m.get("available"):
            print(f"[router] → {model_id} (gratuit OpenCode)", flush=True)
            return model_id

    # Codex en dernier recours (abonnement payant)
    cdx = _state["backends"].get("codex", {})
    if cdx.get("available"):
        print("[router] → Codex gpt-5.5 (dernier recours payant)", flush=True)
        return "codex"

    # LM Studio local
    lms = _state["backends"].get("lm_studio", {})
    if lms.get("available") and lms.get("models"):
        print("[router] → LM Studio qwen", flush=True)
        return "lm_studio"

    return "claude"


def route_to_codex(text: str) -> str:
    """Appelle Codex CLI gpt-5.5 via subprocess (mode non-interactif)."""
    result = subprocess.run(
        ["codex", "exec", "--model", "gpt-5.5", text],
        capture_output=True, text=True, timeout=120,
        encoding="utf-8", errors="replace"
    )
    out = result.stdout.strip()
    # Codex ajoute du bruit (timestamps, token counts) — extraire la vraie réponse
    lines = [l for l in out.splitlines() if l and not l.startswith("2026") and "tokens used" not in l]
    return "\n".join(lines).strip() or result.stderr.strip()


OPENCODE_FREE = {
    "big_pickle":       "opencode/big-pickle",
    "minimax_m2.5":     "opencode/minimax-m2.5-free",
    "gpt_5_nano":       "opencode/gpt-5-nano",
    "hy3_preview":      "opencode/hy3-preview-free",
    "nemotron_3_super": "opencode/nemotron-3-super-free",
}
OPENCODE_CMD = r"C:\Users\Smedj\AppData\Roaming\npm\opencode.cmd"

def probe_opencode_models() -> dict:
    """Vérifie si opencode est disponible."""
    available = Path(OPENCODE_CMD).exists()
    if available:
        return {k: {"available": True, "model": v, "cost": "free"} for k, v in OPENCODE_FREE.items()}
    return {k: {"available": False} for k in OPENCODE_FREE}


def probe_all():
    """Sonde périodique de tous les backends."""
    while True:
        usage   = probe_claude_usage()
        lms     = probe_lm_studio()
        cdx     = probe_codex()
        oc      = probe_opencode_models()
        with _lock:
            _state["usage"]    = usage
            _state["backends"] = {"codex": cdx, "lm_studio": lms, **oc}
            _state["active_backend"] = decide_backend(usage)
        time.sleep(60)


def auto_benchmark_loop():
    """Auto-test périodique pour mettre à jour les pondérations dynamiques.
    Tourne toutes les heures avec un set de questions standard."""
    BENCH_QUESTIONS = [
        "Quelle est la capitale du Japon ?",
        "Combien font 17 fois 23 ?",
        "Cite trois langages de programmation modernes.",
        "Qu'est-ce que la quantification d'un modèle LLM ?",
        "En une phrase, c'est quoi le RAG ?",
    ]
    # Attendre 5 min après démarrage avant 1er benchmark
    time.sleep(300)
    while True:
        try:
            print(f"[v2 auto-bench] début round", flush=True)
            for q in BENCH_QUESTIONS:
                try:
                    route_v2(q)
                    time.sleep(10)  # respiration entre questions
                except Exception as e:
                    print(f"[v2 auto-bench] err: {e}", flush=True)
            with _runtime_lock:
                stats = {k: dict(v) for k, v in _model_runtime.items()}
            print(f"[v2 auto-bench] fin — stats: {stats}", flush=True)
        except Exception as e:
            print(f"[v2 auto-bench] crash loop: {e}", flush=True)
        time.sleep(3600)  # 1h entre rounds


# ─── Routing requêtes ─────────────────────────────────────────────────────────
def route_to_local(text: str, backend: str) -> str:
    """Envoie une requête à un backend local (LM Studio ou Ollama)."""
    if backend == "lm_studio":
        lms = _state["backends"].get("lm_studio", {})
        model = select_lmstudio_model(
            task_type="short",
            automatic=True,
            available_models=lms.get("models", []),
        )
        url = f"{LM_STUDIO}/v1/chat/completions"
        payload = {
            "model": model,
            "messages": [
            {"role": "system", "content": "/no_think\nAnswer directly. Do not expose reasoning."},
            {"role": "user", "content": "/no_think\n" + text},
        ],
            "temperature": 0.7,
            "max_tokens": 800,
            "stream": False,
        }
        payload = json.dumps(add_lmstudio_ttl(payload)).encode("utf-8")
        req = urllib.request.Request(url, data=payload,
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=120) as r:
            d = json.loads(r.read().decode())
            return extract_lmstudio_content(d["choices"][0], expect_json=False)

    elif backend == "ollama":
        oll = _state["backends"].get("ollama", {})
        model = oll.get("models", ["llama3.2"])[0]
        url = f"{OLLAMA}/api/generate"
        payload = json.dumps({"model": model, "prompt": text, "stream": False}).encode()
        req = urllib.request.Request(url, data=payload,
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=120) as r:
            d = json.loads(r.read().decode())
            return d.get("response", "")

    return ""


# ─── v2 : parallèle + juge + cascade FrugalGPT ────────────────────────────────
import concurrent.futures, subprocess, difflib

JUDGE_THRESHOLD_BASE   = 7.0    # score min de base
SELF_CONSISTENCY_K     = 0.65   # ratio Jaccard pour consensus
COOLDOWN_FAILS         = 3      # N échecs consécutifs → cooldown du modèle
COOLDOWN_DURATION      = 1800   # 30 min de cooldown
BENCHMARK_LOG          = Path(r"C:\Users\Smedj\Documents\Obsidian Vault\.vault-llm-benchmark-iag.json")

# État dynamique des modèles
_model_runtime = {
    k: {"consecutive_fails": 0, "cooldown_until": 0.0, "wins": 0, "calls": 0, "avg_latency": 0.0}
    for k in OPENCODE_FREE
}
_runtime_lock = threading.Lock()

def _is_in_cooldown(model_key: str) -> bool:
    with _runtime_lock:
        return _model_runtime[model_key]["cooldown_until"] > time.time()

def _record_call(model_key: str, success: bool, latency: float, won: bool = False):
    with _runtime_lock:
        s = _model_runtime[model_key]
        s["calls"] += 1
        # Moyenne mobile latence
        s["avg_latency"] = 0.8 * s["avg_latency"] + 0.2 * latency if s["avg_latency"] else latency
        if success:
            s["consecutive_fails"] = 0
        else:
            s["consecutive_fails"] += 1
            if s["consecutive_fails"] >= COOLDOWN_FAILS:
                s["cooldown_until"] = time.time() + COOLDOWN_DURATION
                print(f"[v2] {model_key} en cooldown {COOLDOWN_DURATION//60}min", flush=True)
        if won:
            s["wins"] += 1

def _model_priority(model_key: str) -> float:
    """Score de priorité : winrate * 0.7 + (1 - latency_norm) * 0.3."""
    with _runtime_lock:
        s = _model_runtime[model_key]
    if s["calls"] < 3:
        return 0.5  # neutre tant qu'on n'a pas de données
    winrate = s["wins"] / s["calls"]
    # Latency normalisée vs moyenne globale (10s baseline)
    latency_score = max(0, 1 - (s["avg_latency"] / 30.0))
    return 0.7 * winrate + 0.3 * latency_score

def _adaptive_threshold() -> float:
    """Seuil du juge ajusté selon quota Claude : si quota élevé, plus permissif (économise)."""
    usage = _state.get("usage", {})
    five_h = (usage.get("five_hour") or {}).get("utilization", 50)
    seven_d = (usage.get("seven_day") or {}).get("utilization", 50)
    pressure = max(five_h, seven_d)
    # > 80% : très permissif (6.0), <30% : exigeant (8.0), milieu : 7.0
    if pressure >= 80: return 6.0
    if pressure >= 60: return 6.5
    if pressure <= 30: return 8.0
    return JUDGE_THRESHOLD_BASE

def _is_simple_question(text: str) -> bool:
    """Heuristique : courte, factuelle, pas de code, pas de demande complexe."""
    t = text.strip()
    if len(t) > 150: return False
    if re.search(r'```|def |class |function|import |const |let |var |implement|architecture', t, re.I):
        return False
    if re.search(r'(comment|pourquoi|explique|détaille|analyse|compare|liste|résume)', t, re.I):
        return False
    # Question factuelle simple : "Quelle...?", "Qui...?", "Combien...?", "Quand...?"
    if re.search(r'\b(quel|qui|combien|quand|où|c\'est quoi|how|what|who|when|where)\b', t, re.I):
        return True
    return False

_opencode_semaphore = threading.Semaphore(2)  # max 2 opencode concurrents

def _call_opencode(model_key: str, text: str, timeout: int = 60) -> tuple[str, str | None, float]:
    """Appelle opencode avec prompt via stdin. Sémaphore global évite la saturation."""
    t0 = time.time()
    if not _opencode_semaphore.acquire(timeout=timeout):
        return (model_key, None, time.time() - t0)
    try:
        model_id = OPENCODE_FREE[model_key]
        r = subprocess.run(
            [OPENCODE_CMD, "run", "--model", model_id, "-"],  # "-" = lire stdin
            input=text,
            capture_output=True, text=True, timeout=timeout,
            encoding="utf-8", errors="replace"
        )
        lines = [l for l in r.stdout.splitlines()
                 if l.strip() and not l.startswith(">") and "\x1b" not in l and "build" not in l.lower()]
        response = "\n".join(lines).strip()
        if not response:
            # Fallback : si stdin pas supporté par cette version, retomber sur arg
            r2 = subprocess.run(
                [OPENCODE_CMD, "run", "--model", model_id, text],
                capture_output=True, text=True, timeout=timeout,
                encoding="utf-8", errors="replace"
            )
            lines = [l for l in r2.stdout.splitlines()
                     if l.strip() and not l.startswith(">") and "\x1b" not in l and "build" not in l.lower()]
            response = "\n".join(lines).strip()
        if not response:
            return (model_key, None, time.time() - t0)
        return (model_key, response, time.time() - t0)
    except Exception as e:
        print(f"[v2] {model_key} err: {e}", flush=True)
        return (model_key, None, time.time() - t0)
    finally:
        try: _opencode_semaphore.release()
        except: pass

def _call_lm_studio(prompt: str, timeout: int = 60, max_tokens: int = 800) -> str | None:
    try:
        lms = _state["backends"].get("lm_studio", {})
        if not lms.get("available"): return None
        model = select_lmstudio_model(
            task_type="eval",
            automatic=True,
            available_models=lms.get("models", []),
        )
        url = f"{LM_STUDIO}/v1/chat/completions"
        payload = {
            "model": model,
            "messages": [
            {"role": "system", "content": "/no_think\nOutput only the final answer. No hidden reasoning. No markdown unless explicitly requested."},
            {"role": "user", "content": "/no_think\n" + prompt},
        ],
            "temperature": 0.3, "max_tokens": max_tokens, "stream": False,
        }
        payload = json.dumps(add_lmstudio_ttl(payload)).encode()
        req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return extract_lmstudio_content(json.loads(r.read().decode())["choices"][0], expect_json=False)
    except Exception as e:
        print(f"[v2] lm_studio err: {e}", flush=True)
        return None

def _normalize(text: str) -> set:
    """Tokenise pour Jaccard similarity."""
    return set(re.findall(r'\w+', text.lower())) if text else set()

def _jaccard(a: set, b: set) -> float:
    if not a or not b: return 0.0
    return len(a & b) / len(a | b)

def _self_consistency(responses: dict) -> str | None:
    """Si plusieurs modèles donnent une réponse similaire, retourne celle-là.
    responses: {model_key: response_text}"""
    valid = [(k, v) for k, v in responses.items() if v]
    if len(valid) < 2: return None
    norms = {k: _normalize(v) for k, v in valid}
    # Compter pour chaque réponse combien d'autres sont similaires
    best_key, best_count = None, 0
    for k1, n1 in norms.items():
        count = sum(1 for k2, n2 in norms.items() if k1 != k2 and _jaccard(n1, n2) >= SELF_CONSISTENCY_K)
        if count > best_count:
            best_count, best_key = count, k1
    # Consensus si au moins 2 modèles agree (donc count >= 1 pour le best)
    if best_count >= 1:
        return best_key
    return None

def _extract_scores(raw: str, n_letters: int) -> dict:
    """Extrait robustement {letter: score} depuis n'importe quel format de juge LLM.
    Cherche d'abord JSON, puis patterns markdown / table / inline."""
    if not raw: return {}
    expected = [chr(65 + i) for i in range(n_letters)]
    result = {}

    # Tentative 1 : JSON valide
    for m in re.finditer(r'\{[^{}]+\}', raw):
        try:
            d = json.loads(m.group(0))
            for k, v in d.items():
                kk = k.strip().upper()[:1]
                if kk in expected:
                    try: result[kk] = float(v)
                    except: pass
            if result: return result
        except: continue

    # Tentative 2 : patterns "A: 8", "A → 8", "A | 8", "A**: **8/10", "A) 7"
    for letter in expected:
        # Patterns variés
        patterns = [
            rf'\*?\*?{letter}\*?\*?\s*[:→\-=)|]+\s*\*?\*?(\d+(?:\.\d+)?)\s*\*?\*?(?:\s*/\s*10)?',
            rf'(?:^|\W){letter}\s*[:|]\s*(\d+(?:\.\d+)?)',
            rf'Réponse\s+{letter}\s*[:\-]?\s*\*?\*?(\d+(?:\.\d+)?)',
        ]
        for pat in patterns:
            m = re.search(pat, raw, re.MULTILINE | re.IGNORECASE)
            if m:
                try:
                    score = float(m.group(1))
                    if 0 <= score <= 10:
                        result[letter] = score
                        break
                except: pass
    return result

def _judge_one(judge_key: str, question: str, shuffled_responses: list, judge_call_fn) -> dict:
    """Un juge note les réponses anonymisées. Retourne {letter: score}."""
    items = "\n\n".join(f"### Réponse {chr(65+i)}\n{v}" for i, (_, v) in enumerate(shuffled_responses))
    prompt = (
        f"Tu es un juge. Note chaque réponse de 0 à 10 selon : exactitude factuelle, pertinence, clarté concise. "
        f"Ne récompense pas la verbosité.\n\n"
        f"## Question\n{question}\n\n"
        f"## Réponses anonymes\n{items}\n\n"
        f"Format strict (1 ligne par réponse) :\n"
        f"A: 8\nB: 6\nC: 9\n..."
    )
    try:
        raw = judge_call_fn(prompt)
        if not raw: return {}
        scores = _extract_scores(raw, len(shuffled_responses))
        if not scores:
            print(f"[v2] judge {judge_key} no scores parsed, raw: {raw[:200]!r}", flush=True)
        return scores
    except Exception as e:
        print(f"[v2] judge {judge_key} err: {e}", flush=True)
        return {}

def _panel_judge(question: str, responses: dict, include_claude: bool = False) -> dict:
    """Conglomérat de juges anonymisé. Tronque candidats à 300 chars, limite à 3 juges rapides + qwen."""
    valid = [(k, v) for k, v in responses.items() if v]
    if len(valid) < 2: return {}

    import random as _rnd
    # Tronquer chaque candidat à 300 chars pour réduire taille prompt
    truncated = [(k, (v[:300] + ("..." if len(v) > 300 else ""))) for k, v in valid]
    shuffled = truncated.copy(); _rnd.shuffle(shuffled)
    letter_to_key = {chr(65 + i): k for i, (k, _) in enumerate(shuffled)}

    # Panel : qwen externe (si LM Studio actif) + top-2 free models
    free_judges = sorted(responses.keys(), key=_model_priority, reverse=True)[:2]
    lms_state = _state["backends"].get("lm_studio", {})
    if lms_state.get("available"):
        judges = ["qwen_external"] + free_judges
    else:
        judges = free_judges  # skip qwen si LM Studio down — évite timeout

    all_judgments = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(judges)) as ex:
        futures = {}
        for judge in judges:
            if judge == "qwen_external":
                fn = lambda p: _call_lm_studio(p, max_tokens=150, timeout=30)
            else:
                fn = lambda p, jk=judge: _call_opencode(jk, p, timeout=30)[1]
            futures[ex.submit(_judge_one, judge, question, shuffled, fn)] = judge
        for f in concurrent.futures.as_completed(futures, timeout=60):
            judge = futures[f]
            try:
                scores = f.result()
                all_judgments[judge] = scores
                if scores:
                    print(f"[v2 panel] {judge} → {scores}", flush=True)
            except Exception as e:
                all_judgments[judge] = {}
                print(f"[v2 panel] {judge} crash: {e}", flush=True)

    # Aggréger anti-auto-favoritisme
    aggregated = {k: [] for k, _ in valid}
    for judge, scores in all_judgments.items():
        for letter, score in scores.items():
            target_key = letter_to_key.get(letter)
            if not target_key or judge == target_key: continue
            aggregated[target_key].append(score)
    final = {k: sum(v)/len(v) for k, v in aggregated.items() if v}
    print(f"[v2 panel] {len(judges)} juges, agrégé: {final}", flush=True)
    return final

# Alias rétro-compatibilité
def _judge_responses(question: str, responses: dict) -> dict:
    return _panel_judge(question, responses)

def _log_v2_round(question: str, responses: dict, latencies: dict, scores: dict, winner: str):
    """Log chaque round dans .vault-llm-benchmark-iag.json pour benchmark continu."""
    import datetime as _dt
    log_file = Path(r"C:\Users\Smedj\Documents\Obsidian Vault\.vault-llm-benchmark-iag.json")
    try:
        existing = json.loads(log_file.read_text(encoding="utf-8")) if log_file.exists() else {"rounds": []}
        if not isinstance(existing, dict) or "rounds" not in existing: existing = {"rounds": []}
        existing["rounds"].append({
            "ts": _dt.datetime.now().isoformat(),
            "question": question[:200],
            "responses": {k: (v[:300] if v else None) for k, v in responses.items()},
            "latencies": latencies,
            "scores": scores,
            "winner": winner,
        })
        # Garder les 200 derniers rounds
        existing["rounds"] = existing["rounds"][-200:]
        log_file.write_text(json.dumps(existing, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception as e:
        print(f"[v2] log err: {e}", flush=True)

def _record_winner(winner: str, path: str, scores: dict | None = None):
    """Met à jour l'état v2 visible dans /status pour l'UI."""
    with _lock:
        _state["v2_last_winner"] = winner
        _state["v2_last_path"] = path
        _state["v2_last_scores"] = scores or {}
        _state["v2_last_ts"] = time.time()

def route_v2(text: str) -> dict:
    """Pipeline v2 intelligent :
    - Skip cooldowned models
    - Question simple → top-priority model only (1 appel, pas de juge)
    - Question complexe → parallèle + self-consistency + juge adaptatif + cascade
    """
    # Filtrer les modèles en cooldown
    available = [k for k in OPENCODE_FREE
                 if _state["backends"].get(k, {}).get("available") and not _is_in_cooldown(k)]
    if not available:
        return {"backend": "claude", "inject": True, "text": text, "v2_path": "no_free_available"}

    # Trier par priorité dynamique (winrate + latency)
    available.sort(key=_model_priority, reverse=True)
    threshold = _adaptive_threshold()
    simple = _is_simple_question(text)

    # ─── Question simple : un seul modèle (le top-priority) ─────────────────
    if simple:
        top = available[0]
        print(f"[v2] simple Q → solo {top} (threshold={threshold})", flush=True)
        _, resp, lat = _call_opencode(top, text, timeout=30)
        if resp:
            _record_call(top, success=True, latency=lat, won=True)
            _log_v2_round(text, {top: resp}, {top: lat}, {}, top)
            _record_winner(top, "simple_solo")
            return {"backend": top, "inject": False, "response": resp,
                    "v2_path": "simple_solo", "model_priority": _model_priority(top)}
        _record_call(top, success=False, latency=lat)
        # Échec solo → retombe sur parallèle
        print(f"[v2] solo {top} failed → fallback parallel", flush=True)

    # ─── Question complexe : parallèle ───────────────────────────────────────
    print(f"[v2] parallel → {available} (threshold={threshold})", flush=True)
    responses, latencies = {}, {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(available)) as ex:
        futures = {ex.submit(_call_opencode, k, text): k for k in available}
        try:
            for f in concurrent.futures.as_completed(futures, timeout=70):
                k, resp, lat = f.result()
                responses[k] = resp; latencies[k] = lat
                _record_call(k, success=resp is not None, latency=lat)
        except concurrent.futures.TimeoutError:
            print(f"[v2] timeout global, on prend ce qu'on a", flush=True)

    valid = {k: v for k, v in responses.items() if v}
    print(f"[v2] {len(valid)}/{len(available)} valides", flush=True)
    if not valid:
        return {"backend": "claude", "inject": True, "text": text, "v2_path": "all_free_failed"}

    # Self-consistency
    consensus = _self_consistency(valid)
    if consensus:
        print(f"[v2] consensus → {consensus}", flush=True)
        _record_call(consensus, True, latencies.get(consensus, 0), won=True)
        _log_v2_round(text, responses, latencies, {}, consensus)
        _record_winner(consensus, "consensus")
        return {"backend": consensus, "inject": False, "response": valid[consensus],
                "v2_path": "consensus", "candidates": list(valid.keys())}

    # Juge avec seuil adaptatif
    scores = _judge_responses(text, valid)
    if scores:
        winner_key, winner_score = max(scores.items(), key=lambda x: x[1])
        print(f"[v2] judge scores={scores} winner={winner_key}@{winner_score} threshold={threshold}", flush=True)
        if winner_score >= threshold:
            _record_call(winner_key, True, latencies.get(winner_key, 0), won=True)
            _record_call(winner_key, True, latencies.get(winner_key, 0), won=True)
            _log_v2_round(text, responses, latencies, scores, winner_key)
            _record_winner(winner_key, "judge_pass", scores)
            return {"backend": winner_key, "inject": False, "response": valid[winner_key],
                    "v2_path": "judge_pass", "score": winner_score, "all_scores": scores,
                    "threshold": threshold}

    # PAS de cascade Claude : Sam préfère économiser le quota (Claude Code l'utilise déjà).
    # On va direct sur lm_studio (qwen) puis fallback best free.

    # Codex fallback
    cdx = _state["backends"].get("codex", {})
    if cdx.get("available"):
        try:
            resp = route_to_codex(text)
            _log_v2_round(text, responses, latencies, scores, "codex")
            _record_winner("codex", "escalate_codex", scores)
            return {"backend": "codex", "inject": False, "response": resp, "v2_path": "escalate_codex"}
        except Exception: pass

    # Dernier recours : meilleur free même si score bas
    best_free = max(valid.keys(), key=lambda k: scores.get(k, 0))
    _record_call(best_free, True, latencies.get(best_free, 0), won=True)
    _log_v2_round(text, responses, latencies, scores, best_free)
    _record_winner(best_free, "fallback_best_free", scores)
    return {"backend": best_free, "inject": False, "response": valid[best_free],
            "v2_path": "fallback_best_free", "warning": "no flagship available"}


# ─── HTTP Handler ─────────────────────────────────────────────────────────────
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/v2_state":
            # Snapshot d'abord (lock court), priorité calculée après (sans lock pour éviter deadlock)
            with _runtime_lock:
                snapshot = {k: dict(v) for k, v in _model_runtime.items()}
            stats = {}
            for k, v in snapshot.items():
                prio = _model_priority(k)  # acquiert le lock à nouveau, OK car sorti
                stats[k] = {**v, "in_cooldown": v["cooldown_until"] > time.time(),
                            "priority": prio}
            payload = {
                "models": stats,
                "threshold": _adaptive_threshold(),
                "claude_rate_limited": _claude_rate_limited,
                "self_consistency_k": SELF_CONSISTENCY_K,
            }
            data = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers(); self.wfile.write(data)
            return
        if self.path == "/status":
            with _lock:
                data = json.dumps({**_state, "models": MODEL_INFO, "claude_rate_limited": _claude_rate_limited}, ensure_ascii=False, indent=2).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        else:
            self.send_error(404)

    def do_POST(self):
        if self.path == "/route_v2":
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length).decode("utf-8-sig"))
            text = body.get("text", "")
            try:
                result = route_v2(text)
            except Exception as e:
                print(f"[v2] err: {e}", flush=True)
                result = {"backend": "claude", "inject": True, "text": text, "error": str(e)}
            data = json.dumps(result, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers(); self.wfile.write(data)
            return
        if self.path == "/route":
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length).decode("utf-8-sig"))
            text    = body.get("text", "")
            context = body.get("context", "voice")

            with _lock:
                backend = _state["active_backend"]
                _state["request_count"] += 1
                _state["last_route"] = {"backend": backend, "context": context, "ts": time.time()}

            print(f"[router] → {backend} | {context} | {text[:50]!r}", flush=True)

            if backend == "claude":
                result = {"backend": "claude", "inject": True, "text": text}
            elif backend in OPENCODE_FREE:
                try:
                    model_id = OPENCODE_FREE[backend]
                    r = subprocess.run(
                        [OPENCODE_CMD, "run", "--model", model_id, text],
                        capture_output=True, text=True, timeout=60,
                        encoding="utf-8", errors="replace"
                    )
                    lines = [l for l in r.stdout.splitlines()
                             if l.strip() and not l.startswith(">") and "\x1b" not in l and "build" not in l.lower()]
                    response = "\n".join(lines).strip() or "Pas de réponse"
                    result = {"backend": backend, "inject": False, "response": response}
                except Exception as e:
                    result = {"backend": "claude", "inject": True, "text": text, "fallback": True}
            elif backend == "codex":
                try:
                    response = route_to_codex(text)
                    result = {"backend": "codex", "inject": False, "response": response}
                except Exception as e:
                    print(f"[router] ✗ codex: {e} → fallback claude", flush=True)
                    result = {"backend": "claude", "inject": True, "text": text, "fallback": True}
            else:
                try:
                    response = route_to_local(text, backend)
                    result = {"backend": backend, "inject": False, "response": response}
                except Exception as e:
                    print(f"[router] ✗ {backend}: {e} → fallback claude", flush=True)
                    result = {"backend": "claude", "inject": True, "text": text, "fallback": True}

            data = json.dumps(result, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        else:
            self.send_error(404)

    def log_message(self, fmt, *args):
        pass  # Silence les logs HTTP


# ─── Main ─────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    print("=== LLM Router ===", flush=True)
    # Init immédiate des backends sans attendre le thread
    with _lock:
        _state["backends"] = {**probe_opencode_models(), "codex": probe_codex(), "lm_studio": {}, "ollama": {}}
    threading.Thread(target=probe_all, daemon=True).start()
    threading.Thread(target=auto_benchmark_loop, daemon=True).start()

    with _lock:
        print(f"[router] Backend actif : {_state['active_backend']}", flush=True)
        free = [k for k,v in _state['backends'].items() if v.get('available') and v.get('cost')=='free']
        print(f"[router] Modèles gratuits : {free}", flush=True)

    print(f"[router] Écoute sur port {PORT}", flush=True)
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()
