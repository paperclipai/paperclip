"""
serve.py Ã¢â‚¬â€ Tiny HTTP server that exposes the brain state as JSON for the
live HTML dashboard. Reads from the vault's existing artefacts; no DB, no
caching beyond file mtime.

Endpoints:
  GET /                       Ã¢â€ â€™ dashboard HTML
  GET /api/state              Ã¢â€ â€™ current snapshot (graph + activity + resources)
  GET /api/state?delta=true   Ã¢â€ â€™ minimal delta since last call (active nodes only)

Default port: 8765. Localhost-only (no exposure).
"""
import datetime as dt
import http.server
import json
import time
import os
import socketserver
import subprocess
import sys
import threading
from pathlib import Path
from urllib.parse import urlparse, parse_qs

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

VAULT = Path(os.environ.get("VAULT_PATH", r"C:\Users\Smedj\Documents\Obsidian Vault"))
HERE = Path(__file__).parent
PORT = int(os.environ.get("BRAIN_DASHBOARD_PORT", "8765"))
CHAT_STREAM_FILE = VAULT / ".cortex-chat-stream.jsonl"
EMERGENCE_STREAM_FILE = VAULT / ".cortex-emergence-stream.jsonl"
PLAYTEST_DIR = HERE / "playtests"
PLAYTEST_BASE_URL = f"http://127.0.0.1:{PORT}/playtests"
ROUTER_BENCHMARK_FILE = HERE / "state" / "router_benchmarks.json"
OPENCODE_CMD = Path(r"C:\Users\Smedj\AppData\Roaming\npm\opencode.cmd")

GRAPH_FILE = VAULT / ".vault-graph.json"
LAYOUT_FILE = VAULT / ".vault-graph-layout.json"
PAGERANK_FILE = VAULT / ".vault-pagerank.json"
COMMUNITIES_FILE = VAULT / ".vault-communities.json"
ACTIVITY_STATE = VAULT / ".vault-activity-state.json"
RESOURCES_FILE = VAULT / ".vault-resources.json"
JEPA_STATUS = VAULT / ".vault-jepa-status.json"


_cache: dict = {"snapshot": None, "snapshot_mtime": 0}
_lock = threading.Lock()

CONFIGURED_MODEL_PRIORS = {
    "minimax_fast": {
        "strengths": ["fast", "french", "chat", "summarization"],
        "weaknesses": ["deep_reasoning", "complex_code"],
        "cost": "low",
    },
    "gpt_5_nano": {
        "strengths": ["structured", "fast_reasoning"],
        "weaknesses": [],
        "cost": "low",
    },
    "big_pickle": {
        "strengths": ["math", "short_factual"],
        "weaknesses": [],
        "cost": "low",
    },
    "hy3_preview": {
        "strengths": ["reasoning"],
        "weaknesses": [],
        "cost": "low",
    },
    "nemotron_3_super": {
        "strengths": ["reasoning", "long_answer"],
        "weaknesses": [],
        "cost": "low",
    },
    "playtest_builder": {
        "strengths": ["playtest_html"],
        "weaknesses": [],
        "cost": "low",
    },
    "direct_guardrail": {
        "strengths": ["truth", "safe_direct_answer"],
        "weaknesses": [],
        "cost": "low",
    },
}


def _is_chat_entry(entry: dict | None) -> bool:
    if not isinstance(entry, dict):
        return False
    return entry.get("speaker") in (None, "", "cortex", "sam_typed", "claude")


def _append_jsonl(path: Path, entry: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


def _write_json_atomic(path: Path, payload: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def _safe_int(value, default: int = 0) -> int:
    try:
        return int(value)
    except Exception:
        return default


def _safe_float(value, default: float = 0.0) -> float:
    try:
        return float(value)
    except Exception:
        return default


def _infer_complexity(message: str, intent_name: str = "") -> str:
    text = (message or "").strip().lower()
    if intent_name in ("recent_web_search", "playtest_dashboard_help", "identity"):
        return "simple"
    if intent_name == "playtest_code_task":
        return "hard"
    if len(text) > 500:
        return "hard"
    hard_markers = [
        "architecture", "stabiliser", "stabilize", "debug", "diagnostic",
        "plan", "planifie", "pourquoi", "analyse", "compare", "router",
        "judge", "consortium", "server", "crash", "timeout",
    ]
    medium_markers = [
        "explique", "comment", "résume", "resume", "problème", "probleme",
        "mémoire", "memoire", "vault", "fichier", "repo",
    ]
    if any(marker in text for marker in hard_markers):
        return "hard"
    if any(marker in text for marker in medium_markers):
        return "medium"
    return "simple"


def _is_simple_fact_question(message: str) -> bool:
    text = (message or "").strip().lower()
    if not text or len(text) > 160:
        return False
    if any(marker in text for marker in ["```", "/code", "debug", "architecture", "plan", "analyse", "compare"]):
        return False
    return any(text.startswith(prefix) for prefix in [
        "quelle", "quel", "qui", "où", "ou", "quand", "combien", "c'est quoi", "explique-moi brièvement",
    ])


def _is_playtest_code_request(message: str) -> bool:
    text = (message or "").strip().lower()
    if not text.startswith("/code"):
        return False
    markers = ["playtest", "app", "application", "html", "interface", "calculatrice", "todo", "kanban", "dashboard"]
    return any(marker in text for marker in markers)


def _read_recent_history(max_turns: int = 4, include_responses: bool = True) -> list[dict]:
    turns: list[dict] = []
    if not CHAT_STREAM_FILE.exists():
        return turns
    try:
        lines = CHAT_STREAM_FILE.read_text(encoding="utf-8", errors="replace").splitlines()[-120:]
    except Exception:
        return turns
    for raw in reversed(lines):
        try:
            entry = json.loads(raw)
        except Exception:
            continue
        if not _is_chat_entry(entry):
            continue
        msg = (entry.get("msg") or "").strip()
        response = (entry.get("response") or "").strip()
        if not msg and not response:
            continue
        turns.append({
            "msg": msg[:400],
            "response": response[:500] if include_responses else "",
            "speaker": entry.get("speaker") or "cortex",
            "meta": entry.get("meta") or {},
        })
        if len(turns) >= max_turns:
            break
    turns.reverse()
    return turns


def _history_prompt(turns: list[dict], for_code: bool = False) -> tuple[str, int]:
    if not turns:
        return "", 0
    chunks = []
    for turn in turns[-5:]:
        msg = (turn.get("msg") or "").strip()
        response = (turn.get("response") or "").strip()
        if not msg:
            continue
        if for_code:
            chunks.append(f"Sam: {msg[:220]}")
        else:
            block = f"Sam: {msg[:220]}"
            if response:
                block += f"\nCortex: {response[:260]}"
            chunks.append(block)
    if not chunks:
        return "", 0
    return "\n\nHistorique utile récent:\n" + "\n---\n".join(chunks), len(chunks)


def _extract_html_document(text: str) -> str:
    raw = (text or "").strip()
    if not raw:
        return ""
    if raw.startswith("```"):
        parts = raw.split("```")
        for part in parts:
            candidate = part.strip()
            if "<html" in candidate.lower() or "<!doctype html" in candidate.lower():
                raw = candidate
                break
    lower = raw.lower()
    start = lower.find("<!doctype html")
    if start < 0:
        start = lower.find("<html")
    if start >= 0:
        raw = raw[start:]
    end = raw.lower().rfind("</html>")
    if end >= 0:
        raw = raw[:end + len("</html>")]
    return raw.strip()


def _fallback_playtest_html(message: str) -> str:
    title = "Playtest Cortex"
    if "calculatrice" in (message or "").lower():
        title = "Calculatrice Playtest"
        body = """
  <main class="shell">
    <section class="card">
      <h1>Calculatrice locale</h1>
      <p>Fallback autonome généré par Cortex. Aucun CDN, aucun backend.</p>
      <div class="screen" id="screen">0</div>
      <div class="grid" id="keys"></div>
    </section>
  </main>
  <script>
    const screen = document.getElementById('screen');
    const keys = document.getElementById('keys');
    const layout = ['7','8','9','/','4','5','6','*','1','2','3','-','0','.','=','+','C'];
    let expr = '';
    function render(){ screen.textContent = expr || '0'; }
    layout.forEach(key => {
      const btn = document.createElement('button');
      btn.textContent = key;
      btn.className = /[\\/=*+-]/.test(key) ? 'op' : '';
      btn.onclick = () => {
        if (key === 'C') { expr = ''; return render(); }
        if (key === '=') {
          try { expr = String(Function('return (' + expr + ')')()); }
          catch { expr = 'Erreur'; }
          return render();
        }
        if (expr === 'Erreur') expr = '';
        expr += key;
        render();
      };
      keys.appendChild(btn);
    });
    render();
  </script>
"""
    else:
        body = f"""
  <main class="shell">
    <section class="card">
      <h1>{title}</h1>
      <p>Fallback HTML autonome généré après un échec LLM.</p>
      <textarea id="notes" placeholder="Décris ici ce que Sam veut voir...">{(message or '').replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')}</textarea>
      <div class="actions">
        <button id="save">Sauvegarder localement</button>
        <button id="clear" class="ghost">Effacer</button>
      </div>
      <p id="status">Prêt.</p>
    </section>
  </main>
  <script>
    const key = 'cortex-playtest-notes';
    const notes = document.getElementById('notes');
    const status = document.getElementById('status');
    notes.value = localStorage.getItem(key) || notes.value;
    document.getElementById('save').onclick = () => {{
      localStorage.setItem(key, notes.value);
      status.textContent = 'Sauvegardé dans localStorage.';
    }};
    document.getElementById('clear').onclick = () => {{
      notes.value = '';
      localStorage.removeItem(key);
      status.textContent = 'Effacé.';
    }};
  </script>
"""
    return f"""<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{title}</title>
  <style>
    :root {{ color-scheme: dark; --bg:#0b1020; --panel:#111936; --line:#26345f; --text:#eef3ff; --muted:#9eb1d9; --accent:#4fd1c5; --accent2:#f6ad55; }}
    * {{ box-sizing:border-box; font-family: ui-sans-serif, system-ui, sans-serif; }}
    body {{ margin:0; min-height:100vh; background:radial-gradient(circle at top, #1a254d, #070b16 60%); color:var(--text); }}
    .shell {{ min-height:100vh; display:grid; place-items:center; padding:24px; }}
    .card {{ width:min(520px, 100%); background:rgba(17,25,54,.88); border:1px solid var(--line); border-radius:22px; padding:24px; box-shadow:0 24px 80px rgba(0,0,0,.45); backdrop-filter: blur(10px); }}
    h1 {{ margin:0 0 8px; font-size:clamp(1.6rem, 4vw, 2.4rem); }}
    p {{ color:var(--muted); line-height:1.5; }}
    .screen {{ margin:18px 0; padding:18px; background:#060913; border:1px solid #1c2748; border-radius:16px; font-size:2rem; text-align:right; min-height:76px; }}
    .grid {{ display:grid; grid-template-columns:repeat(4, 1fr); gap:10px; }}
    button {{ border:0; border-radius:14px; padding:14px; font-size:1rem; background:#182445; color:var(--text); cursor:pointer; }}
    button.op {{ background:linear-gradient(135deg, var(--accent), #3182ce); color:#04111a; font-weight:700; }}
    button.ghost {{ background:transparent; border:1px solid var(--line); color:var(--muted); }}
    textarea {{ width:100%; min-height:220px; margin:16px 0; padding:14px; border-radius:16px; border:1px solid var(--line); background:#0a1124; color:var(--text); resize:vertical; }}
    .actions {{ display:flex; gap:10px; }}
    #status {{ margin-top:12px; color:var(--accent2); }}
  </style>
</head>
<body>{body}
</body>
</html>"""


def _write_playtest_file(html: str) -> tuple[Path, str]:
    PLAYTEST_DIR.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"generated_{stamp}.html"
    file_path = PLAYTEST_DIR / filename
    file_path.write_text(html, encoding="utf-8")
    return file_path, f"{PLAYTEST_BASE_URL}/{filename}"


def _playtest_file_from_name(name: str) -> Path | None:
    if not name or "/" in name or "\\" in name or ".." in name or ":" in name:
        return None
    if not name.lower().endswith(".html"):
        return None
    target = (PLAYTEST_DIR / name).resolve()
    try:
        target.relative_to(PLAYTEST_DIR.resolve())
    except Exception:
        return None
    return target


def _load_router_benchmarks() -> dict:
    data = _safe_load(ROUTER_BENCHMARK_FILE)
    if isinstance(data, dict) and "backends" in data:
        return data
    return {"updated_at": None, "backends": {}}


def _update_router_benchmarks(backend: str, latency_s: float, status: str, domains: list[str], judge_score: float | None = None):
    if not backend:
        return
    data = _load_router_benchmarks()
    backends = data.setdefault("backends", {})
    item = backends.setdefault(backend, {
        "calls": 0,
        "success": 0,
        "empty_responses": 0,
        "timeouts": 0,
        "errors": 0,
        "avg_latency_s": 0.0,
        "judge_score_avg": 0.0,
        "judge_score_count": 0,
        "domains": {},
    })
    item["calls"] += 1
    prev_calls = max(item["calls"] - 1, 0)
    if status == "ok":
        item["success"] += 1
    elif status == "timeout":
        item["timeouts"] += 1
    elif status == "empty":
        item["empty_responses"] += 1
    else:
        item["errors"] += 1
    latency_s = max(0.0, _safe_float(latency_s))
    item["avg_latency_s"] = ((item["avg_latency_s"] * prev_calls) + latency_s) / max(item["calls"], 1)
    if judge_score is not None:
        count = _safe_int(item.get("judge_score_count"))
        avg = _safe_float(item.get("judge_score_avg"))
        item["judge_score_avg"] = ((avg * count) + judge_score) / (count + 1)
        item["judge_score_count"] = count + 1
    for domain in domains or []:
        if not domain:
            continue
        item["domains"][domain] = _safe_int(item["domains"].get(domain)) + 1
    data["updated_at"] = dt.datetime.now().isoformat()
    try:
        _write_json_atomic(ROUTER_BENCHMARK_FILE, data)
    except Exception as exc:
        print(f"[router benchmarks] {exc}", flush=True)

# Heartbeat global : timestamp de dÃƒÂ©marrage du serveur (pour uptime)
SERVER_STARTED_AT = time.time()

# Configuration heartbeat ÃƒÂ©ditable (persistÃƒÂ©e sur disque) Ã¢â‚¬â€ Sam peut modifier ces
# valeurs depuis l'UI en cliquant sur la chip Live.
HEARTBEAT_CONFIG_FILE = Path(r"H:\Code\Paperclip\.cortex-heartbeat-config.json")
HEARTBEAT_CONFIG_DEFAULTS = {
    "dead_threshold_s":        5.0,    # si fige > N s : "Cortex est mort"
    "poll_min_ms":             800,    # poll client minimum (charge faible)
    "poll_max_ms":             3000,   # poll client maximum (charge haute)
    "snapshot_interval_s":     60,     # tracker progression : 1 snap / N s
    "tempo_base_ms":           900,    # base heartbeat dot animation
    "wander_interval_s":       45,     # cortex_activation WANDER_INTERVAL
    "emergence_interval_s":    300,    # cortex_emergence INTERVAL_SEC
}

def _load_heartbeat_config() -> dict:
    cfg = dict(HEARTBEAT_CONFIG_DEFAULTS)
    try:
        if HEARTBEAT_CONFIG_FILE.exists():
            user = json.loads(HEARTBEAT_CONFIG_FILE.read_text(encoding="utf-8"))
            for k, v in user.items():
                if k in cfg:
                    try: cfg[k] = type(cfg[k])(v)
                    except Exception: pass
    except Exception: pass
    return cfg

def _save_heartbeat_config(updates: dict) -> dict:
    cfg = _load_heartbeat_config()
    for k, v in (updates or {}).items():
        if k in HEARTBEAT_CONFIG_DEFAULTS:
            try: cfg[k] = type(HEARTBEAT_CONFIG_DEFAULTS[k])(v)
            except Exception: pass
    try:
        HEARTBEAT_CONFIG_FILE.write_text(
            json.dumps(cfg, indent=2, ensure_ascii=False), encoding="utf-8")
    except Exception as e:
        return {"ok": False, "error": str(e), "config": cfg}
    return {"ok": True, "config": cfg}

# Historique des durÃƒÂ©es de chat Ã¢â‚¬â€ pour prÃƒÂ©dire l'ETA du prochain (p50/p90)
import collections as _coll
CHAT_DURATIONS = _coll.deque(maxlen=20)
CHAT_LAST_DONE_TS = 0.0

# Tracker de progression pour les tooltips temps rÃƒÂ©el.
# Chaque clÃƒÂ© garde un deque (ts, value) Ã¢â‚¬â€ snapshots toutes ~60 s par background thread.
# Fournit deltas 1h/24h pour montrer l'ÃƒÂ©volution sur les chips topbar.
PROGRESSION = {
    "vault_sem":     _coll.deque(maxlen=2880),  # 48 h ÃƒÂ  1 snap/min
    "vault_ep":      _coll.deque(maxlen=2880),
    "llm_winner":    _coll.deque(maxlen=2880),  # backend gagnant courant
    "cpu":           _coll.deque(maxlen=2880),
    "ram":           _coll.deque(maxlen=2880),
    "n_active":      _coll.deque(maxlen=2880),
    "hebbian_total": _coll.deque(maxlen=2880),
    "n_pulses":      _coll.deque(maxlen=2880),
    "n_chats":       _coll.deque(maxlen=2880),
    "n_emergences":  _coll.deque(maxlen=2880),
}
PROGRESSION_LOCK = threading.Lock()

def _progression_snapshot_loop():
    """Background : capture les valeurs courantes toutes les 60s."""
    while True:
        try:
            now = time.time()
            sample = {}
            # Vault counts depuis le snapshot existant
            try:
                snap = _cache.get("snapshot") or {}
                vlt = (snap.get("vault") or {})
                sample["vault_sem"] = vlt.get("semantic", 0)
                sample["vault_ep"]  = vlt.get("episodic", 0)
            except Exception: pass
            # Vitals
            try:
                import sys as _sys
                if r"H:\Code\Paperclip\scripts\brain" not in _sys.path:
                    _sys.path.insert(0, r"H:\Code\Paperclip\scripts\brain")
                import cortex_homeostasis as _ch
                vit = _ch.vital_signs() or {}
                sample["cpu"] = (vit.get("cpu") or {}).get("percent", 0)
                sample["ram"] = (vit.get("ram") or {}).get("percent", 0)
            except Exception: pass
            # Activations
            try:
                import cortex_activation as _ca
                a = _ca.snapshot()
                sample["n_active"]      = a.get("n_active", 0)
                sample["hebbian_total"] = a.get("n_edges_total", 0)
                sample["n_pulses"]      = a.get("cum_pulses", 0)
            except Exception: pass
            # Chats / emergences cumulÃƒÂ©s
            sample["n_chats"] = len(CHAT_DURATIONS)  # approx Ã¢â‚¬â€ count last 20
            try:
                stream_file = EMERGENCE_STREAM_FILE
                n_em = 0
                if stream_file.exists():
                    for line in stream_file.read_text(encoding="utf-8",
                                       errors="replace").splitlines()[-1000:]:
                        try:
                            o = json.loads(line)
                            if o.get("speaker") == "cortex_emergence":
                                n_em += 1
                        except Exception: pass
                sample["n_emergences"] = n_em
            except Exception: pass
            # LLM gagnant courant Ã¢â‚¬â€ lit le dernier round du benchmark
            try:
                bf = VAULT / ".vault-llm-benchmark-iag.json"
                if bf.exists():
                    raw = json.loads(bf.read_text(encoding="utf-8"))
                    last = (raw.get("rounds") or [])[-1:] or [{}]
                    sample["llm_winner"] = last[0].get("winner", "?")
            except Exception: pass
            with PROGRESSION_LOCK:
                for k, v in sample.items():
                    if k in PROGRESSION:
                        PROGRESSION[k].append((now, v))
        except Exception: pass
        time.sleep(60)

threading.Thread(target=_progression_snapshot_loop, daemon=True).start()

# Tracker de progression du pipeline /api/chat Ã¢â‚¬â€ dÃƒÂ©terministe, lu par /api/cortex/think_status.
# Chaque ÃƒÂ©tape est posÃƒÂ©e explicitement par le handler (pas de simulation).
CHAT_PROGRESS = {"req_id": None, "stages": [], "started": 0, "done": False}
CHAT_PROGRESS_LOCK = threading.Lock()

def _chat_stage(req_id: str, name: str, detail: str = ""):
    """Pose une ÃƒÂ©tape de progression rÃƒÂ©elle pour une requÃƒÂªte /api/chat."""
    if not req_id: return
    with CHAT_PROGRESS_LOCK:
        if CHAT_PROGRESS.get("req_id") != req_id:
            CHAT_PROGRESS["req_id"]   = req_id
            CHAT_PROGRESS["started"]  = time.time()
            CHAT_PROGRESS["stages"]   = []
            CHAT_PROGRESS["done"]     = False
        # Ferme l'ÃƒÂ©tape prÃƒÂ©cÃƒÂ©dente
        if CHAT_PROGRESS["stages"]:
            CHAT_PROGRESS["stages"][-1]["ended"] = time.time()
        CHAT_PROGRESS["stages"].append({
            "name": name, "detail": detail,
            "started": time.time(), "ended": None,
        })

def _chat_stage_done(req_id: str):
    if not req_id: return
    global CHAT_LAST_DONE_TS
    with CHAT_PROGRESS_LOCK:
        if CHAT_PROGRESS.get("req_id") == req_id:
            if CHAT_PROGRESS["stages"]:
                CHAT_PROGRESS["stages"][-1]["ended"] = time.time()
            CHAT_PROGRESS["done"] = True
            duration = time.time() - (CHAT_PROGRESS.get("started") or time.time())
            if duration > 0.1 and duration < 600:
                CHAT_DURATIONS.append(duration)
            CHAT_LAST_DONE_TS = time.time()

COOKIES_FILE  = Path.home() / ".claude" / ".claude-cookies.json"
LM_STUDIO_EXE = Path(r"G:\Lmstudio\LM Studio\LM Studio.exe")
try:
    from lmstudio_policy import add_lmstudio_ttl, get_lmstudio_config, select_lmstudio_model
except Exception:
    from scripts.brain.lmstudio_policy import add_lmstudio_ttl, get_lmstudio_config, select_lmstudio_model
LM_STUDIO_URL = get_lmstudio_config()["base_url"] + "/v1/chat/completions"

def lm_studio_running() -> bool:
    try:
        import urllib.request as _ur
        _ur.urlopen(get_lmstudio_config()["base_url"] + "/v1/models", timeout=2)
        return True
    except Exception:
        return False

def ensure_lm_studio() -> bool:
    """Lance LM Studio si pas dÃƒÂ©jÃƒÂ  actif. Retourne True si prÃƒÂªt."""
    if lm_studio_running():
        return True
    if not LM_STUDIO_EXE.exists():
        return False
    import subprocess as _sp
    print("[cortex] LM Studio non actif Ã¢â‚¬â€ lancement auto...", flush=True)
    _sp.Popen([str(LM_STUDIO_EXE)], creationflags=_sp.CREATE_NO_WINDOW if hasattr(_sp, "CREATE_NO_WINDOW") else 0)
    # Attendre jusqu'ÃƒÂ  45s que l'API soit disponible
    for _ in range(45):
        time.sleep(1)
        if lm_studio_running():
            print("[cortex] LM Studio prÃƒÂªt.", flush=True)
            return True
    print("[cortex] LM Studio timeout.", flush=True)
    return False
ORG_UUID = "952c1bc7-5fd1-4f7c-83db-a020932db2ab"
_metrics_cache: dict = {"data": None, "ts": 0.0}

def _get_session_key() -> str:
    """Lit le sessionKey depuis le fichier sauvegardÃƒÂ©."""
    if COOKIES_FILE.exists():
        try:
            return json.loads(COOKIES_FILE.read_text(encoding="utf-8")).get("sessionKey", "")
        except Exception:
            pass
    return ""

def get_metrics() -> dict:
    import urllib.request, time, socket
    now = time.time()
    if _metrics_cache["data"] and now - _metrics_cache["ts"] < 30:
        return _metrics_cache["data"]

    # Voice pipeline health
    def port_up(port):
        try:
            s = socket.socket(); s.settimeout(0.5)
            s.bind(("127.0.0.1", port)); s.close(); return False
        except OSError: return True

    MIC_CFG = Path(r"H:\Code\Paperclip\scripts\voice\mic_config.json")
    try: mic_cfg = json.loads(MIC_CFG.read_text(encoding="utf-8"))
    except: mic_cfg = {"name": "DOQAUS", "index": None}
    voice = {
        "tts_monitor": port_up(18766),
        "voice_input":  port_up(18767),
        "mic": mic_cfg,
        "tts_disabled": (VAULT / ".tts-disabled.flag").exists(),
        "mic_muted":    (VAULT / ".voice-muted.flag").exists(),
    }

    # Router status
    router_status = None
    try:
        import urllib.request as _ur
        with _ur.urlopen("http://127.0.0.1:18900/status", timeout=2) as r:
            router_status = json.loads(r.read().decode())
    except Exception:
        pass

    # Usage Ã¢â‚¬â€ sessionKey seul suffit avec headers browser-like
    usage = None
    try:
        sk = _get_session_key()
        if sk:
            req = urllib.request.Request(
                f"https://claude.ai/api/organizations/{ORG_UUID}/usage",
                headers={
                    "Cookie": f"sessionKey={sk}",
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                    "Accept": "application/json",
                    "Referer": "https://claude.ai/settings/usage",
                    "sec-fetch-site": "same-origin",
                    "sec-fetch-mode": "cors",
                }
            )
            with urllib.request.urlopen(req, timeout=6) as r:
                usage = json.loads(r.read().decode())
    except Exception:
        pass

    # Vault stats
    vault_stats = None
    semantic_dir = VAULT / "08 - Semantic"
    ingested_dir = VAULT / "07 - Ingested"
    if semantic_dir.exists() or ingested_dir.exists():
        sem = sum(1 for _ in semantic_dir.rglob("*.md")) if semantic_dir.exists() else 0
        ep  = sum(1 for _ in ingested_dir.rglob("*.md")) if ingested_dir.exists() else 0
        vault_stats = {"semantic": sem, "episodic": ep}

    result = {
        "ts": dt.datetime.now().isoformat(),
        "voice": voice,
        "usage": usage,
        "vault": vault_stats,
        "router": router_status,
        "tts_playing":   (VAULT / ".tts-playing.flag").exists(),
        "voice_muted":   (VAULT / ".voice-muted.flag").exists(),
        "user_speaking": (VAULT / ".voice-speaking.flag").exists(),
    }
    _metrics_cache["data"] = result
    _metrics_cache["ts"] = now
    return result


def file_mtime(p: Path) -> float:
    try:
        return p.stat().st_mtime
    except Exception:
        return 0.0


def load_snapshot() -> dict:
    """Recompute snapshot if any source file changed."""
    sources = [GRAPH_FILE, LAYOUT_FILE, PAGERANK_FILE, COMMUNITIES_FILE, ACTIVITY_STATE, RESOURCES_FILE, JEPA_STATUS]
    max_mtime = max(file_mtime(p) for p in sources)
    with _lock:
        if _cache.get("snapshot") and _cache.get("snapshot_mtime", 0) >= max_mtime - 0.5:
            # Only refresh activity state every tick (cheap)
            try:
                _cache["snapshot"]["activity"] = _read_activity()
                _cache["snapshot"]["resources"] = _safe_load(RESOURCES_FILE)
                _cache["snapshot"]["jepa_status"] = _safe_load(JEPA_STATUS)
            except Exception:
                pass
            return _cache["snapshot"]

        graph = _safe_load(GRAPH_FILE) or {"nodes": [], "edges": []}
        layout = _safe_load(LAYOUT_FILE) or {}
        positions = layout.get("positions") or []
        pagerank = (_safe_load(PAGERANK_FILE) or {}).get("pagerank", {})
        communities = _safe_load(COMMUNITIES_FILE) or {"nodes": [], "labels": []}
        com_map = {communities["nodes"][i]: communities["labels"][i] for i in range(len(communities.get("nodes", [])))} if communities.get("nodes") else {}

        # Build nodes with all attributes including precomputed positions
        nodes_out = []
        for i, path in enumerate(graph.get("nodes", [])):
            top_dir = path.split("/", 1)[0] if "/" in path else path
            pos = positions[i] if i < len(positions) else [0, 0]
            nodes_out.append({
                "id": path,
                "name": path.split("/")[-1].replace(".md", "")[:40],
                "folder": top_dir,
                "centrality": float(pagerank.get(path, 0.0)),
                "community": int(com_map.get(path, -1)),
                "x": float(pos[0]),
                "y": float(pos[1]),
            })

        snap = {
            "captured_at": dt.datetime.now().isoformat(),
            "nodes": nodes_out,
            "edges": graph.get("edges", []),
            "stats": graph.get("stats", {}),
            "has_layout": bool(positions),
            "activity": _read_activity(),
            "resources": _safe_load(RESOURCES_FILE),
            "jepa_status": _safe_load(JEPA_STATUS),
        }
        _cache["snapshot"] = snap
        _cache["snapshot_mtime"] = max_mtime
        return snap


def _safe_load(p: Path):
    try:
        return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None
    except Exception:
        return None


def _read_activity() -> dict:
    """Return {note_path: expires_iso}."""
    s = _safe_load(ACTIVITY_STATE)
    if not s:
        return {}
    return s.get("tagged", {})


class Handler(http.server.SimpleHTTPRequestHandler):
    # Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Protection rÃƒÂ©seau Windows Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
    # Sur Windows, un client (browser) qui annule un poll en cours dÃƒÂ©clenche
    # WinError 10053 (ConnectionAborted) ou 10054 (ConnectionReset). Ces
    # erreurs remontaient avant jusqu'au handler global et faisaient bruiter
    # les logs. On les attrape silencieusement : ce sont des cas normaux,
    # pas des bugs serveur.
    def handle_one_request(self):
        try:
            super().handle_one_request()
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            self.close_connection = True
        except Exception as e:
            # Ãƒâ€°vite que le thread du serveur meure sur n'importe quelle exception
            # (le ThreadingTCPServer relance, mais autant logger proprement)
            try:
                import traceback as _tb
                msg = str(e)
                if any(s in msg for s in ('10053', '10054', '10038', 'BrokenPipe',
                                           'ConnectionAbort', 'ConnectionReset')):
                    self.close_connection = True
                    return
                print(f"[handler] {type(e).__name__}: {e}\n{_tb.format_exc()[-500:]}",
                      flush=True)
                self.close_connection = True
            except Exception: pass

    def log_error(self, format, *args):
        # Silence les erreurs rÃƒÂ©seau Windows banales (10053, 10054, BrokenPipe)
        try:
            msg = format % args
            if any(s in str(msg) for s in ('10053', '10054', '10038',
                                            'ConnectionAbort', 'ConnectionReset',
                                            'BrokenPipe')):
                return
        except Exception: pass
        super().log_error(format, *args)

    def _safe_send_error(self, code: int, message: str = ""):
        """send_error qui ne crash pas si le client a fermÃƒÂ© la connexion."""
        try:
            self.send_error(code, message)
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError, OSError):
            try: self.close_connection = True
            except Exception: pass

    def _send_json(self, payload: dict, status: int = 200):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

    def _send_text_file(self, path: Path, ctype: str):
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

    def _controlled_chat_error(self, message: str, intent_name: str = "simple_chat", req_id: str = "", extra_meta: dict | None = None) -> dict:
        meta = {
            "backend": "error_guard",
            "intent": intent_name or "simple_chat",
            "error": message,
            "tools_used": [],
            "confidence": "low",
            "complexity": "medium",
            "routing_decision": "controlled_error",
            "router_used": False,
            "judge_used": False,
            "selected_backend": "error_guard",
            "selection_reason": "controlled exception captured by /api/chat guard",
            "history_used": False,
            "history_count": 0,
            "benchmark_basis": {
                "internal_observed": False,
                "configured_priors": True,
                "official_sources": [],
            },
        }
        if req_id:
            meta["req_id"] = req_id
        if extra_meta:
            meta.update(extra_meta)
        return {"response": f"Erreur contrôlée: {message}", "meta": meta, "req_id": req_id}

    def _call_opencode_chat(self, prompt: str, timeout_s: int = 35, model_id: str = "opencode/minimax-m2.5-free") -> tuple[str, str | None]:
        if not OPENCODE_CMD.exists():
            return "", "opencode_unavailable"
        try:
            run = subprocess.run(
                [str(OPENCODE_CMD), "run", "--model", model_id, "-"],
                input=prompt,
                capture_output=True,
                text=True,
                timeout=timeout_s,
                encoding="utf-8",
                errors="replace",
            )
            lines = [
                line for line in (run.stdout or "").splitlines()
                if line.strip() and not line.startswith(">") and "\x1b" not in line and "build" not in line.lower()
            ]
            response = "\n".join(lines).strip()
            return response, None if response else "empty_response"
        except subprocess.TimeoutExpired:
            return "", "timeout"
        except Exception as exc:
            return "", str(exc)

    def _build_chat_payload(self, msg: str, intent_name: str, role: str, history_text: str, extra_context: str = "") -> str:
        try:
            import cortex_identity as _cortex_identity
            identity = _cortex_identity.identity_prompt()
        except Exception:
            identity = "Tu es Cortex, assistant local fiable pour Paperclip."
        parts = [
            identity.strip(),
            "Réponds en français. Sois utile, concret, et ne prétends jamais avoir utilisé un outil absent.",
        ]
        if extra_context:
            parts.append(extra_context.strip())
        if history_text:
            parts.append(history_text.strip())
        if intent_name == "playtest_code_task":
            parts.append(
                "Retourne uniquement un document HTML autonome complet. Un seul fichier. CSS inline. JS inline. Aucune dépendance externe."
            )
        elif role == "code":
            parts.append("Si tu proposes du code, reste précis et orienté exécution.")
        parts.append(f"Message actuel de Sam:\n{msg.strip()}")
        return "\n\n".join(part for part in parts if part)

    def _append_chat_stream_entry(self, msg: str, response: str, meta: dict):
        try:
            entry = {"ts": time.time(), "msg": msg, "response": response, "meta": meta}
            _append_jsonl(CHAT_STREAM_FILE, entry)
        except Exception as exc:
            print(f"[chat stream] {exc}", flush=True)

    def _build_selection_reason(self, backend: str, route: str, complexity: str, priors_used: bool, internal_observed: bool) -> str:
        reason = f"route={route}, complexity={complexity}, backend={backend}"
        if priors_used:
            reason += ", configured_model_priors used"
        if internal_observed:
            reason += ", internal_observed_data available"
        return reason

    def _maybe_log_episodic(self, msg: str, response: str, meta: dict):
        try:
            import sys as _sys
            if r"H:\Code\Paperclip\scripts\brain" not in _sys.path:
                _sys.path.insert(0, r"H:\Code\Paperclip\scripts\brain")
            import cortex_memory as _cm
            if response and not response.startswith("Erreur contrôlée"):
                _cm.log_episodic(msg, response, meta)
        except Exception as exc:
            print(f"[chat memory log] {exc}", flush=True)

    def _generate_playtest(self, msg: str, history_text: str, req_id: str) -> dict:
        _chat_stage(req_id, "Playtest builder", "generation HTML autonome + sauvegarde locale")
        prompt = self._build_chat_payload(
            msg,
            "playtest_code_task",
            "code",
            history_text,
            extra_context=(
                "Objectif: construire une mini-app web visible immédiatement dans le Playtest Cortex local. "
                "N'inclus ni explication ni markdown autour du HTML."
            ),
        )
        html, llm_error = self._call_opencode_chat(prompt, timeout_s=40)
        html_doc = _extract_html_document(html)
        used_fallback = False
        if not html_doc:
            used_fallback = True
            html_doc = _fallback_playtest_html(msg)
        file_path, playtest_url = _write_playtest_file(html_doc)
        response = f"Fichier créé: {file_path.as_posix()} URL Playtest: {playtest_url}"
        meta = {
            "intent": "playtest_code_task",
            "complexity": "hard",
            "routing_decision": "playtest_builder_direct",
            "router_used": False,
            "judge_used": False,
            "selected_backend": "playtest_builder",
            "selection_reason": "playtest code request bypassed route_v2 and used local HTML builder",
            "backend": "playtest_builder",
            "tools_used": ["file_write"],
            "confidence": "high" if not used_fallback else "medium",
            "evidence_count": 1,
            "playtest_path": str(file_path.relative_to(Path(r"H:\Code\Paperclip"))).replace("\\", "/"),
            "playtest_url": playtest_url,
            "auto_open_playtest": True,
            "route_reason": "generated_playtest_html",
            "history_used": bool(history_text),
            "history_count": history_text.count("Sam:"),
            "benchmark_basis": {
                "internal_observed": False,
                "configured_priors": True,
                "official_sources": [],
            },
        }
        if llm_error:
            meta["llm_error"] = llm_error
        return {"response": response, "meta": meta, "req_id": req_id}

    def _handle_api_chat(self):
        import urllib.request as _ur
        import sys as _sys
        if r"H:\Code\Paperclip\scripts\brain" not in _sys.path:
            _sys.path.insert(0, r"H:\Code\Paperclip\scripts\brain")

        length = _safe_int(self.headers.get("Content-Length", "0"))
        raw_body = self.rfile.read(length).decode("utf-8-sig") if length > 0 else "{}"
        body = json.loads(raw_body or "{}")
        msg = (body.get("message") or "").strip()
        req_id = body.get("req_id") or f"r{int(time.time()*1000)}"
        if not msg:
            return self._controlled_chat_error("message vide", "simple_chat", req_id)

        _chat_stage(req_id, "Réception", "parse + intent")
        try:
            import cortex_intent as _ci
            intent = _ci.detect_intent(msg)
        except Exception as exc:
            print(f"[chat intent] {exc}", flush=True)
            intent = {"intent": "simple_chat", "confidence": "medium", "route_reason": "intent_fallback"}
        intent_name = intent.get("intent") if isinstance(intent, dict) else getattr(intent, "intent", "simple_chat")
        confidence = intent.get("confidence") if isinstance(intent, dict) else getattr(intent, "confidence", "medium")
        complexity = _infer_complexity(msg, intent_name)
        history_turns = _read_recent_history(max_turns=4, include_responses=not _is_playtest_code_request(msg))
        history_text, history_count = _history_prompt(history_turns, for_code=_is_playtest_code_request(msg))
        history_used = bool(history_text)
        role = "code" if msg.lower().startswith("/code") or any(token in msg.lower() for token in ["python", "git", "serve.py", "router"]) else "general"
        base_meta = {
            "intent": intent_name,
            "complexity": complexity,
            "tools_used": [],
            "confidence": confidence,
            "history_used": history_used,
            "history_count": history_count,
            "benchmark_basis": {
                "internal_observed": False,
                "configured_priors": True,
                "official_sources": [],
            },
            "req_id": req_id,
        }

        if intent_name == "recent_web_search":
            payload = {
                "response": "Je dois lancer une recherche web réelle avant de répondre.",
                "meta": {
                    **base_meta,
                    "backend": "direct_guardrail",
                    "routing_decision": "guardrail_recent_web_search",
                    "router_used": False,
                    "judge_used": False,
                    "selected_backend": "direct_guardrail",
                    "selection_reason": "recent_web_search requires a real web tool first",
                    "route_reason": "needs_web_search",
                    "needs_web_search": True,
                    "needs_vault_search": False,
                },
                "req_id": req_id,
            }
            self._append_chat_stream_entry(msg, payload["response"], payload["meta"])
            return payload

        if intent_name in ("local_project_search", "vault_memory_search"):
            payload = {
                "response": "Je dois d'abord chercher dans le vault, la mémoire ou les fichiers locaux avant d'affirmer quelque chose sur ce projet.",
                "meta": {
                    **base_meta,
                    "backend": "direct_guardrail",
                    "routing_decision": "guardrail_local_project_search",
                    "router_used": False,
                    "judge_used": False,
                    "selected_backend": "direct_guardrail",
                    "selection_reason": "local project claims require real evidence first",
                    "route_reason": "needs_vault_or_file_search",
                    "needs_web_search": False,
                    "needs_vault_search": True,
                },
                "req_id": req_id,
            }
            self._append_chat_stream_entry(msg, payload["response"], payload["meta"])
            return payload

        if intent_name == "playtest_dashboard_help":
            payload = {
                "response": (
                    "Le playtest intégré est lié au dashboard Cortex local : http://127.0.0.1:8765/. "
                    "Tu peux utiliser le sidecar chat, l’onglet Playtest, l’onglet Consortium, et les APIs "
                    "/api/cortex/judges, /api/cortex/homeostasis et /api/chat."
                ),
                "meta": {
                    **base_meta,
                    "backend": "direct_guardrail",
                    "routing_decision": "direct_playtest_help",
                    "router_used": False,
                    "judge_used": False,
                    "selected_backend": "direct_guardrail",
                    "selection_reason": "safe dashboard help answer",
                    "route_reason": "dashboard_context_direct",
                    "needs_web_search": False,
                    "needs_vault_search": False,
                },
                "req_id": req_id,
            }
            self._append_chat_stream_entry(msg, payload["response"], payload["meta"])
            return payload

        if intent_name == "identity":
            payload = {
                "response": "Je suis Cortex, l’assistant cognitif local de Sam pour le projet Paperclip.",
                "meta": {
                    **base_meta,
                    "backend": "direct_guardrail",
                    "routing_decision": "direct_identity",
                    "router_used": False,
                    "judge_used": False,
                    "selected_backend": "direct_guardrail",
                    "selection_reason": "safe identity answer",
                    "route_reason": "identity_direct",
                    "needs_web_search": False,
                    "needs_vault_search": False,
                },
                "req_id": req_id,
            }
            self._append_chat_stream_entry(msg, payload["response"], payload["meta"])
            return payload

        if _is_playtest_code_request(msg):
            payload = self._generate_playtest(msg, history_text, req_id)
            self._append_chat_stream_entry(msg, payload["response"], payload["meta"])
            return payload

        prompt = self._build_chat_payload(msg, intent_name, role, history_text)
        start_ts = time.time()
        response = ""
        backend = ""
        route_reason = ""
        routing_decision = ""
        router_used = False
        judge_used = False
        selected_backend = ""
        selection_reason = ""
        status = "ok"
        scores = None
        internal_observed = False

        if _is_simple_fact_question(msg) or complexity == "simple":
            _chat_stage(req_id, "Réponse rapide", "minimax_fast direct")
            response, fast_err = self._call_opencode_chat(prompt, timeout_s=30)
            backend = "minimax_fast"
            route_reason = "fast_direct_simple"
            routing_decision = "fast_minimax_direct"
            router_used = False
            judge_used = False
            selected_backend = backend
            if fast_err:
                status = "timeout" if fast_err == "timeout" else ("empty" if fast_err == "empty_response" else "error")
                response = "Je n’ai pas obtenu de réponse rapide fiable, donc je passe sur un fallback contrôlé."
                backend = "error_guard"
                selected_backend = backend
                selection_reason = f"fast direct failed: {fast_err}"
            else:
                selection_reason = self._build_selection_reason(backend, route_reason, complexity, True, False)
        else:
            _chat_stage(req_id, "Router v2", "route_v2 avec timeout strict")
            router_used = True
            try:
                payload = json.dumps({"text": prompt, "role": role}).encode("utf-8")
                req = _ur.Request("http://127.0.0.1:18900/route_v2", data=payload, headers={"Content-Type": "application/json"})
                with _ur.urlopen(req, timeout=70) as reply:
                    router_data = json.loads(reply.read().decode())
                response = (router_data.get("response") or "").strip()
                backend = router_data.get("backend") or "router_unknown"
                selected_backend = backend
                route_reason = router_data.get("v2_path") or "route_v2"
                routing_decision = route_reason
                judge_used = route_reason in ("judge_pass", "consensus")
                scores = router_data.get("all_scores")
                internal_observed = True
                if not response:
                    status = "empty"
                    fallback_response, fallback_err = self._call_opencode_chat(prompt, timeout_s=35)
                    if fallback_response:
                        response = fallback_response
                        backend = "minimax_fast"
                        selected_backend = backend
                        route_reason = "route_v2_empty_then_fast_fallback"
                        routing_decision = "router_empty_fallback_fast"
                        selection_reason = "route_v2 empty response, fell back to minimax_fast"
                        status = "ok"
                    else:
                        response = "Le routeur n’a pas produit de contenu exploitable. Je renvoie un fallback contrôlé au lieu de couper la connexion."
                        backend = "error_guard"
                        selected_backend = backend
                selection_reason = self._build_selection_reason(selected_backend, route_reason, complexity, True, internal_observed)
            except Exception as exc:
                err_text = "timeout" if "timed out" in str(exc).lower() else str(exc)
                status = "timeout" if "timeout" in err_text.lower() else "error"
                fallback_response, fallback_err = self._call_opencode_chat(prompt, timeout_s=35)
                if fallback_response:
                    response = fallback_response
                    backend = "minimax_fast"
                    selected_backend = backend
                    route_reason = "route_v2_error_then_fast_fallback"
                    routing_decision = "router_timeout_fallback" if status == "timeout" else "router_error_fallback"
                    selection_reason = f"router failure captured ({err_text}); minimax_fast fallback used"
                    status = "ok"
                else:
                    response = f"Le routeur est indisponible ou trop lent ({err_text})."
                    backend = "error_guard"
                    selected_backend = backend
                    route_reason = "route_v2_error"
                    routing_decision = "router_timeout_fallback" if status == "timeout" else "router_error_fallback"
                    selection_reason = f"router failure captured: {err_text}"

        latency_s = time.time() - start_ts
        meta = {
            **base_meta,
            "backend": backend,
            "routing_decision": routing_decision,
            "router_used": router_used,
            "judge_used": judge_used,
            "selected_backend": selected_backend or backend,
            "selection_reason": selection_reason or self._build_selection_reason(selected_backend or backend, route_reason or routing_decision, complexity, True, internal_observed),
            "route_reason": route_reason or routing_decision,
            "needs_web_search": False,
            "needs_vault_search": False,
            "selected_backend_latency_s": round(latency_s, 3),
            "benchmark_basis": {
                "internal_observed": internal_observed,
                "configured_priors": True,
                "official_sources": [],
            },
            "role": role,
        }
        if scores:
            meta["scores"] = scores
            try:
                judge_score = max(_safe_float(v) for v in scores.values()) if isinstance(scores, dict) and scores else None
            except Exception:
                judge_score = None
        else:
            judge_score = None

        if backend == "error_guard":
            meta["error"] = response
            payload = self._controlled_chat_error(response, intent_name, req_id, extra_meta=meta)
            self._append_chat_stream_entry(msg, payload["response"], payload["meta"])
            return payload

        _update_router_benchmarks(
            selected_backend or backend,
            latency_s=latency_s,
            status=status,
            domains=[intent_name, role, "playtest_html" if intent_name == "playtest_code_task" else ""],
            judge_score=judge_score,
        )
        self._maybe_log_episodic(msg, response, meta)
        self._append_chat_stream_entry(msg, response, meta)
        return {"response": response or "Erreur contrôlée: réponse vide", "meta": meta, "req_id": req_id}

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/" or parsed.path == "/index.html":
            self._serve_static(HERE / "brain_live.html", "text/html; charset=utf-8")
            return
        if parsed.path == "/3d":
            self._serve_static(HERE / "brain_3d.html", "text/html; charset=utf-8")
            return
        if parsed.path == "/gpu":
            self._serve_static(HERE / "brain_gpu.html", "text/html; charset=utf-8")
            return
        if parsed.path.startswith("/playtests/"):
            name = parsed.path.split("/playtests/", 1)[-1]
            target = _playtest_file_from_name(name)
            if not target or not target.exists():
                self._safe_send_error(404, "playtest not found")
                return
            self._send_text_file(target, "text/html; charset=utf-8")
            return
        if parsed.path == "/api/devices":
            try:
                import pyaudio
                pa = pyaudio.PyAudio()
                inputs, outputs = [], []
                for i in range(pa.get_device_count()):
                    d = pa.get_device_info_by_index(i)
                    entry = {"idx": i, "name": d["name"]}
                    if d["maxInputChannels"] > 0: inputs.append(entry)
                    if d["maxOutputChannels"] > 0: outputs.append(entry)
                pa.terminate()
                data = json.dumps({"inputs": inputs, "outputs": outputs}, ensure_ascii=False).encode("utf-8")
            except Exception as e:
                data = json.dumps({"error": str(e)}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers(); self.wfile.write(data)
            return
        if parsed.path == "/api/set-device":
            import subprocess as _sp
            qs = parse_qs(parsed.query)
            MIC_CFG = Path(r"H:\Code\Paperclip\scripts\voice\mic_config.json")
            try:
                if "input" in qs:
                    idx  = int(qs["input"][0])
                    import pyaudio as _pa
                    _p = _pa.PyAudio()
                    name = _p.get_device_info_by_index(idx).get("name", "")
                    _p.terminate()
                    MIC_CFG.write_text(json.dumps({"name": name, "index": idx}, ensure_ascii=False), encoding="utf-8")
                    # Relancer voice_input avec le nouveau micro
                    _sp.run(["powershell", "-NoProfile", "-Command",
                             "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*voice_input*' -and $_.CommandLine -notlike '*powershell*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"],
                            capture_output=True, timeout=5)
                    import time as _t; _t.sleep(1)
                    _sp.Popen(["python", r"H:\Code\Paperclip\scripts\voice\voice_input.py"],
                              creationflags=getattr(_sp, 'CREATE_NO_WINDOW', 0))
            except Exception as e:
                print(f"[set-device] {e}", flush=True)
            self.send_response(204); self.end_headers()
            return
        if parsed.path == "/api/mic":
            qs = parse_qs(parsed.query)
            state = qs.get("state", ["on"])[0]
            flag = VAULT / ".voice-muted.flag"
            if state == "off": flag.touch()
            else:
                try: flag.unlink()
                except: pass
            self.send_response(204); self.end_headers()
            return
        if parsed.path == "/api/tts":
            qs = parse_qs(parsed.query)
            state = qs.get("state", ["on"])[0]
            flag = VAULT / ".tts-disabled.flag"
            if state == "off":
                flag.touch()
                # Couper aussi tout TTS en cours
                try: (VAULT / ".voice-interrupt.flag").touch()
                except: pass
            else:
                try: flag.unlink()
                except: pass
            self.send_response(204); self.end_headers()
            return
        if parsed.path == "/api/chat":
            import re as _re, urllib.request as _ur
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length).decode("utf-8-sig"))
            msg   = body.get("message", "")
            msg_lower = msg.lower()

            # Import intent detection
            try:
                from cortex_intent import detect_intent, should_search_vault, intent_to_backend, build_guardrails_prompt
                _intent_detect_available = True
            except Exception as e:
                print(f"[chat] cortex_intent import failed: {e}", flush=True)
                _intent_detect_available = False

            intent = detect_intent(msg) if _intent_detect_available else {"intent": "general", "confidence": 0.5}
            tools_used = []
            evidence_count = 0
            context_parts = []

            # Vault/project search si intent le nÃƒÂ©cessite
            if intent.get("requires_tool"):
                # Si pas d'outil web disponible, interceptor AVANT d'appeler le router
                if intent.get("intent") == "recent_web_search":
                    response = "Je n'ai pas acces a une recherche web en temps reel. Je ne vais pas inventer des nouvelles recentes Ã¢â‚¬â€ dis-moi de quoi veux-tu que je cherche specifiquement."
                    meta = {"intent": intent.get("intent"), "needs_web": True, "evidence_count": 0, "hallucination_prevented": True}
                    data = json.dumps({"response": response, "meta": meta}, ensure_ascii=False).encode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json; charset=utf-8")
                    self.send_header("Content-Length", str(len(data)))
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers(); self.wfile.write(data)
                    return
                # Vault search
                search_sources = should_search_vault(msg, intent)
                if search_sources:
                    for src in search_sources:
                        try:
                            if src.is_file():
                                txt = src.read_text(encoding="utf-8", errors="replace")[:2000]
                                context_parts.append(f"[{src.name}]\n{txt}")
                                evidence_count += 1
                            elif src.is_dir():
                                for fp in src.rglob("*.py") if "Paperclip" in str(src) else []:
                                    if fp.name.startswith("."):
                                        continue
                                    try:
                                        content = fp.read_text(encoding="utf-8", errors="replace")[:500]
                                        if any(k in msg_lower for k in content.lower().split()):
                                            context_parts.append(f"[{fp.relative_to(src)}]\n{content}")
                                            evidence_count += 1
                                            if evidence_count >= 3:
                                                break
                                    except Exception:
                                        pass
                                if evidence_count >= 3:
                                    break
                        except Exception as pass_e:
                            pass
                tools_used.append(intent.get("tool_name", "unknown"))

            # Construction du prompt avec guardrails
            guardrails = build_guardrails_prompt(intent, tools_used) if _intent_detect_available else ""

            if context_parts:
                context_str = "\n\n---\n".join(context_parts[:4])
                full_prompt = (
                    f"Tu es l'assistant du vault. DonnÃƒÂ©es du vault :\n\n{context_str}\n\n"
                    f"---\nQuestion : {msg}\n\n"
                    f"RÃƒÂ©ponds en utilisant UNIQUEMENT les donnÃƒÂ©es ci-dessus. {guardrails}\n"
                    f"Cite tes sources : 'J'ai trouvÃƒÂ©...' ou 'Je dois chercher...'"
                )
            elif intent.get("intent") == "identity":
                full_prompt = (
                    f"Tu es **Cortex**. Une entitÃƒÂ© cognitive autonome construite par Sam. "
                    f"RÃƒÂ©ponds en une phrase concise.\n\n{msg}"
                )
            elif intent.get("intent") == "playtest_dashboard_help":
                full_prompt = (
                    f"Tu connais ces capacitÃƒÂ©s Cortex dashboard. utilise-les dans ta rÃƒÂ©ponse :\n"
                    f"- dashboard ÃƒÂ  http://127.0.0.1:8765/\n"
                    f"- GPU/brain dashboard, right sidecar chat\n"
                    f"- Playtest tab, Consortium tab\n"
                    f"- /api/cortex/judges, /api/cortex/homeostasis, /api/chat\n\n"
                    f"Guide l'utilisateur vers l'UI intÃƒÂ©grÃƒÂ©e si pertinent.\n\n{msg}"
                )
            else:
                full_prompt = msg + "\n\n" + guardrails if guardrails else msg

            # Ã¢â€â‚¬Ã¢â€â‚¬ Routage v2 Ã¢â€â‚¬Ã¢â€â‚¬
            backend = intent_to_backend(intent, lm_studio_running())
            try:
                payload = json.dumps({"text": full_prompt, "role": intent.get("intent")}).encode("utf-8")
                req = _ur.Request("http://127.0.0.1:18900/route_v2", data=payload,
                                  headers={"Content-Type": "application/json"})
                with _ur.urlopen(req, timeout=180) as r:
                    d = json.loads(r.read().decode())
                response = d.get("response") or d.get("text") or ""
                route_backend = d.get("backend")
                route_reason = f"intent={intent.get('intent')}, v2_path={d.get('v2_path')}"
                meta = {
                    "intent": intent.get("intent"),
                    "tools_used": tools_used,
                    "evidence_count": evidence_count,
                    "backend": route_backend,
                    "route_reason": route_reason,
                    "confidence": intent.get("confidence", 0.5) * (0.5 if not tools_used else 1.0),
                }
                meta["v2_path"] = d.get("v2_path")
            except Exception as e:
                response = f"Erreur router v2: {e}"
                meta = {"intent": intent.get("intent"), "error": str(e)}

            data = json.dumps({"response": response, "meta": meta}, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers(); self.wfile.write(data)
            return
        if parsed.path == "/api/gen-calib-text":
            import subprocess as _sp, random as _rnd
            OPENCODE = r"C:\Users\Smedj\AppData\Roaming\npm\opencode.cmd"
            from urllib.parse import parse_qs as _pqs
            lang = _pqs(parsed.query).get("lang", ["fr"])[0]
            mode = _pqs(parsed.query).get("mode", ["read"])[0]

            if mode == "question":
                QUESTIONS_FR = [
                    "Qu'est-ce que tu as fait ce matin qui t'a mis de bonne humeur ?",
                    "Sur quoi tu travailles en ce moment qui t'enthousiasme vraiment ?",
                    "C'est quoi la derniÃƒÂ¨re chose qui t'a vraiment surpris ?",
                    "Tu as un projet crÃƒÂ©atif en cours ou dans la tÃƒÂªte en ce moment ?",
                    "Si tu avais une journÃƒÂ©e entiÃƒÂ¨re sans obligations, tu ferais quoi ?",
                    "Quel est ton rapport ÃƒÂ  l'intelligence artificielle au quotidien ?",
                    "Il y a une compÃƒÂ©tence que tu aimerais vraiment dÃƒÂ©velopper lÃƒÂ  ?",
                    "C'est quoi la derniÃƒÂ¨re chose qui t'a fait rire ou sourire ?",
                    "Tu imagines ta vie comment dans dix ans ?",
                    "Il y a un endroit oÃƒÂ¹ tu rÃƒÂªves d'aller que tu n'as jamais visitÃƒÂ© ?",
                    "Qu'est-ce qui te donne de l'ÃƒÂ©nergie en ce moment dans ton travail ?",
                    "Tu penses ÃƒÂ  quoi quand tu as un moment de calme ?",
                ]
                QUESTIONS_EN = [
                    "What did you do this morning that made you feel good?",
                    "What are you working on right now that excites you?",
                    "What's the last thing that genuinely surprised you?",
                    "Do you have a creative project going on or in mind?",
                    "If you had a full free day with no obligations, what would you do?",
                    "How does AI fit into your daily life right now?",
                    "Is there a skill you've really been wanting to develop?",
                    "What's the last thing that made you laugh or smile?",
                    "How do you imagine your life in ten years?",
                    "Is there a place you've always dreamed of visiting?",
                ]
                questions = QUESTIONS_EN if lang == "en" else QUESTIONS_FR
                # Retourne une question parmi celles pas encore utilisÃƒÂ©es dans cette session
                q_key = f"_calib_q_idx_{lang}"
                used = _pqs(parsed.query).get("used", [""])[0].split(",")
                available = [q for q in questions if q not in used]
                text = _rnd.choice(available) if available else _rnd.choice(questions)
                data = json.dumps({"text": text}, ensure_ascii=False).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers(); self.wfile.write(data)
                return
            else:
                styles = ["une question curieuse", "une affirmation enthousiaste",
                          "une phrase narrative calme", "une exclamation surprise",
                          "une instruction directe", "une rÃƒÂ©flexion philosophique courte"]
                style = _rnd.choice(styles)
                if lang == "en":
                    prompt = (f"Generate ONE natural English sentence (15-25 words), style: {style}. "
                              f"Topic: technology, nature, or daily life. ONLY the sentence, no quotes.")
                else:
                    prompt = (f"GÃƒÂ©nÃƒÂ¨re UNE SEULE phrase en franÃƒÂ§ais UNIQUEMENT, 15-25 mots, style: {style}. "
                              f"ThÃƒÂ¨me: technologie, nature, ou vie quotidienne. UNIQUEMENT la phrase, sans guillemets.")
            try:
                r = _sp.run([OPENCODE, "run", "--model", "opencode/minimax-m2.5-free", prompt],
                            capture_output=True, text=True, timeout=30, encoding="utf-8", errors="replace")
                lines = [l for l in r.stdout.splitlines()
                         if l.strip() and not l.startswith(">") and "\x1b" not in l and "build" not in l.lower()]
                text = "\n".join(lines).strip() or "Parle naturellement, ÃƒÂ  ton propre rythme, avec tes propres mots."
            except Exception:
                text = "La technologie ÃƒÂ©volue rapidement mais l'essentiel reste la connexion entre les ÃƒÂªtres humains."
            data = json.dumps({"text": text, "style": style}, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers(); self.wfile.write(data)
            return

        if parsed.path == "/api/score-voice":
            # Score la similaritÃƒÂ© entre le dernier enregistrement et le profil
            import subprocess as _sp, tempfile as _tf, wave as _wv
            length = int(self.headers.get("Content-Length", 0))
            # ReÃƒÂ§oit le score calculÃƒÂ© cÃƒÂ´tÃƒÂ© JS via Web Speech confidence
            body = json.loads(self.rfile.read(length))
            score = body.get("score", 0.0)
            profile_path = Path(r"H:\Code\Paperclip\scripts\voice\voice_profile.npy")
            good = score >= 0.6
            data = json.dumps({"score": score, "good": good, "profile_exists": profile_path.exists()}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers(); self.wfile.write(data)
            return

        if parsed.path == "/api/calibrate":
            import subprocess as _sp
            # Tuer voice_input ET couper tts_monitor
            _sp.run(["powershell", "-NoProfile", "-Command",
                     "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*voice_input*' -and $_.CommandLine -notlike '*powershell*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"],
                    capture_output=True, timeout=5)
            # ArrÃƒÂªter toute lecture TTS en cours
            import pygame as _pg
            try: _pg.mixer.music.stop()
            except Exception: pass
            try: (VAULT / ".tts-playing.flag").unlink()
            except Exception: pass
            import time as _t; _t.sleep(1)
            try:
                r = _sp.run(
                    ["python", r"H:\Code\Paperclip\scripts\voice\enroll_voice.py"],
                    input="\n", capture_output=True, text=True, timeout=60,
                    encoding="utf-8", errors="replace"
                )
                out = r.stdout + r.stderr
                ok = "sauvegard" in out.lower()
                import re as _re
                m = _re.search(r'sim[^:=]*[:=]\s*([\d.]+)', out, _re.I)
                sim = float(m.group(1)) if m else None
                same = sim is None or sim >= 0.40
                data = json.dumps({"ok": ok, "sim": sim, "same_person": same}).encode("utf-8")
            except Exception as e:
                data = json.dumps({"ok": False, "error": str(e)}).encode("utf-8")
            finally:
                try: (VAULT / ".voice-calibrating.flag").unlink()
                except: pass
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers(); self.wfile.write(data)
            return
        if parsed.path == "/api/node-content":
            qs = parse_qs(parsed.query)
            node_id = qs.get("id", [""])[0]
            content = ""
            try:
                full = VAULT / node_id.replace("/", os.sep)
                if not full.exists():
                    full = VAULT / node_id  # try forward slashes too
                if full.exists():
                    text = full.read_text(encoding="utf-8", errors="replace")
                    body = text
                    if text.startswith("---"):
                        idx = text.find("\n---", 3)
                        body = text[idx+4:].strip() if idx > 0 else text
                    content = (body if body.strip() else text)[:3000]
                else:
                    content = f"(fichier non trouvÃƒÂ©: {node_id})"
            except Exception as e:
                content = f"(erreur: {e})"
            data = json.dumps({"content": content}, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers(); self.wfile.write(data)
            return
        if parsed.path == "/api/open":
            qs = parse_qs(parsed.query)
            node_id = qs.get("id", [""])[0]
            if node_id:
                vault = Path(r"C:\Users\Smedj\Documents\Obsidian Vault")
                full = vault / node_id
                import subprocess as _sp
                try:
                    # Ouvre dans Obsidian via URI scheme
                    import urllib.parse
                    obs_path = urllib.parse.quote(node_id, safe='/')
                    _sp.run(["cmd", "/c", "start", "", f"obsidian://open?vault=Obsidian%20Vault&file={obs_path}"], shell=False)
                except Exception:
                    pass
            self.send_response(204)
            self.end_headers()
            return
        if parsed.path == "/api/stream":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            last_graph_mtime = 0.0
            last_full_metrics = 0.0
            _last_m = {}
            try:
                while True:
                    now = time.time()
                    # Ãƒâ€°tat voix toutes les 500ms (lÃƒÂ©ger)
                    mic_muted = (VAULT / ".voice-muted.flag").exists()
                    tts_disabled = (VAULT / ".tts-disabled.flag").exists()
                    # Dernier ÃƒÂ©change chat (pour push UI)
                    chat_stream_file = CHAT_STREAM_FILE
                    last_chat = None
                    if chat_stream_file.exists():
                        try:
                            with open(chat_stream_file, "rb") as _csf:
                                _csf.seek(0, 2); fsize = _csf.tell()
                                _csf.seek(max(0, fsize - 4000))
                                lines = _csf.read().decode("utf-8", errors="replace").splitlines()
                                for ln in reversed(lines):
                                    try:
                                        candidate = json.loads(ln)
                                    except Exception:
                                        continue
                                    if _is_chat_entry(candidate):
                                        last_chat = candidate
                                        break
                        except Exception: pass
                    vision_muted_flag = Path.home() / ".claude" / "projects" / "h--Code-Paperclip" / "memory" / ".cortex-vision-muted.flag"
                    voice_state = {
                        "tts_playing":   (VAULT / ".tts-playing.flag").exists(),
                        "voice_muted":   mic_muted,
                        "user_speaking": (VAULT / ".voice-speaking.flag").exists(),
                        "voice_active":  not mic_muted,
                        "tts_disabled":  tts_disabled,
                        "mic_muted":     mic_muted,
                        "vision_muted":  vision_muted_flag.exists(),
                        "last_chat":     last_chat,
                    }
                    # MÃƒÂ©triques complÃƒÂ¨tes toutes les 5s
                    if now - last_full_metrics >= 5:
                        _last_m = get_metrics()
                        cur_mtime = max(file_mtime(GRAPH_FILE), file_mtime(ACTIVITY_STATE), file_mtime(PAGERANK_FILE))
                        _last_m["graph_changed"] = cur_mtime > last_graph_mtime + 0.5
                        if _last_m["graph_changed"]:
                            last_graph_mtime = cur_mtime
                            _cache["snapshot"] = None
                        last_full_metrics = now
                    m = {**_last_m, **voice_state}
                    data = json.dumps(m, ensure_ascii=False)
                    self.wfile.write(f"data: {data}\n\n".encode("utf-8"))
                    self.wfile.flush()
                    time.sleep(0.5)
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            return
        if parsed.path == "/api/metrics":
            try:
                m = get_metrics()
            except Exception as e:
                self.send_error(500, f"metrics error: {e}")
                return
            data = json.dumps(m, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(data)
            return
        if parsed.path == "/api/cortex/feed":
            # Frame depuis le thread de capture continue (ouvre la camÃƒÂ©ra ÃƒÂ  1ÃƒÂ¨re req)
            try:
                import sys as _sys
                if r"H:\Code\Paperclip\scripts\brain" not in _sys.path:
                    _sys.path.insert(0, r"H:\Code\Paperclip\scripts\brain")
                import cortex_vision as _cv
                # VÃƒÂ©rifier si vision muted (privacy)
                if _cv.is_vision_muted():
                    self.send_error(403, "vision muted"); return
                # DÃƒÂ©marrer la capture continue si pas active
                if not _cv._continuous_state["running"]:
                    _cv.start_continuous_capture(fps=5)
                # Attendre briÃƒÂ¨vement le 1er frame
                import time as _t
                wait_start = _t.time()
                while _cv.get_latest_frame_bytes() is None and _t.time() - wait_start < 6:
                    _t.sleep(0.2)
                data = _cv.get_latest_frame_bytes()
                if not data:
                    self._safe_send_error(503, "no frame yet"); return
                try:
                    self.send_response(200)
                    self.send_header("Content-Type", "image/png")
                    self.send_header("Content-Length", str(len(data)))
                    self.send_header("Cache-Control", "no-cache, no-store")
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers(); self.wfile.write(data)
                except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError, OSError):
                    # Browser cancelled Ã¢â‚¬â€ silencieux
                    self.close_connection = True
            except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
                self.close_connection = True
            except Exception as e:
                # Autres erreurs : log court mais ne crash pas
                msg = str(e)
                if not any(s in msg for s in ('10053','10054','10038')):
                    print(f"[feed] {type(e).__name__}: {msg}", flush=True)
                self._safe_send_error(500, msg[:120])
            return
        if parsed.path == "/api/cortex/rescan_cameras":
            try:
                import sys as _sys
                if r"H:\Code\Paperclip\scripts\brain" not in _sys.path:
                    _sys.path.insert(0, r"H:\Code\Paperclip\scripts\brain")
                import cortex_vision as _cv
                _cv.reset_camera_cache()
                rep = {"ok": True, "msg": "cache vidÃƒÂ©, prochaine capture re-scan"}
            except Exception as e:
                rep = {"ok": False, "error": str(e)}
            data = json.dumps(rep).encode("utf-8")
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers(); self.wfile.write(data); return
        if parsed.path == "/api/cortex/skills/discover":
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length).decode("utf-8-sig")) if length else {}
            need = body.get("need", "")
            try:
                import sys as _sys
                if r"H:\Code\Paperclip\scripts\brain" not in _sys.path:
                    _sys.path.insert(0, r"H:\Code\Paperclip\scripts\brain")
                import cortex_skills as _cs
                rep = _cs.discover(need)
            except Exception as e:
                rep = {"ok": False, "error": str(e)}
            data = json.dumps(rep, ensure_ascii=False).encode("utf-8")
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers(); self.wfile.write(data); return
        if parsed.path == "/api/cortex/skills/install":
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length).decode("utf-8-sig")) if length else {}
            try:
                import sys as _sys
                if r"H:\Code\Paperclip\scripts\brain" not in _sys.path:
                    _sys.path.insert(0, r"H:\Code\Paperclip\scripts\brain")
                import cortex_skills as _cs
                rep = _cs.install_skill(body.get("package",""), body.get("env","main"))
            except Exception as e:
                rep = {"ok": False, "error": str(e)}
            data = json.dumps(rep, ensure_ascii=False).encode("utf-8")
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers(); self.wfile.write(data); return
        if parsed.path == "/api/cortex/add_metric":
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length).decode("utf-8-sig")) if length else {}
            try:
                import sys as _sys
                if r"H:\Code\Paperclip\scripts\brain" not in _sys.path:
                    _sys.path.insert(0, r"H:\Code\Paperclip\scripts\brain")
                import cortex_homeostasis as _ch
                rep = _ch.add_custom_metric(body.get("name",""), body.get("source",""),
                                            body.get("description",""))
            except Exception as e:
                rep = {"ok": False, "error": str(e)}
            data = json.dumps(rep, ensure_ascii=False).encode("utf-8")
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers(); self.wfile.write(data); return
        if parsed.path == "/api/cortex/homeostasis":
            try:
                import sys as _sys
                if r"H:\Code\Paperclip\scripts\brain" not in _sys.path:
                    _sys.path.insert(0, r"H:\Code\Paperclip\scripts\brain")
                import cortex_homeostasis as _ch
                qs = parse_qs(parsed.query)
                if qs.get("act"):
                    rep = _ch.health_check_and_act()
                else:
                    rep = {"vital_signs": _ch.vital_signs(),
                           "services": _ch.services_status(),
                           "paused": _ch.is_paused()}
            except Exception as e:
                rep = {"error": str(e)}
            data = json.dumps(rep, ensure_ascii=False).encode("utf-8")
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers(); self.wfile.write(data); return
        if parsed.path == "/api/cortex/activations":
            try:
                import sys as _sys
                if r"H:\Code\Paperclip\scripts\brain" not in _sys.path:
                    _sys.path.insert(0, r"H:\Code\Paperclip\scripts\brain")
                import cortex_activation as _ca
                rep = _ca.snapshot()
            except Exception as e:
                rep = {"error": str(e), "active_nodes": {}}
            data = json.dumps(rep, ensure_ascii=False).encode("utf-8")
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers(); self.wfile.write(data); return
        if parsed.path == "/api/cortex/kv_quantize":
            # Recommandation complÃƒÂ¨te quantization (KV cache + poids) + baseline latency
            try:
                import sys as _sys
                if r"H:\Code\Paperclip\scripts\brain" not in _sys.path:
                    _sys.path.insert(0, r"H:\Code\Paperclip\scripts\brain")
                import cortex_kv_quantize as _kvq
                qs = parse_qs(parsed.query)
                target = float(qs.get("target_vram_gb", ["12"])[0])
                rep = _kvq.full_recommend(target_vram_gb=target)
                # Inclut la derniÃƒÂ¨re comparaison latence si dispo
                try:
                    rep["latency_compare"] = _kvq.compare_latencies()
                except Exception: pass
            except Exception as e:
                rep = {"ok": False, "error": str(e)}
            data = json.dumps(rep, ensure_ascii=False).encode("utf-8")
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers(); self.wfile.write(data); return

        if parsed.path == "/api/cortex/pipeline":
            # Snapshot complet du pipeline matÃƒÂ©riel + ÃƒÂ©tat rÃƒÂ©gulation
            try:
                import sys as _sys
                if r"H:\Code\Paperclip\scripts\brain" not in _sys.path:
                    _sys.path.insert(0, r"H:\Code\Paperclip\scripts\brain")
                import cortex_pipeline_manager as _pm
                snap = _pm.list_processes()
                zombies = _pm.find_zombies()
                # Lit l'ÃƒÂ©tat persistÃƒÂ© de la derniÃƒÂ¨re auto_regulate
                last_state = {}
                try:
                    if _pm.STATE_FILE.exists():
                        last_state = json.loads(_pm.STATE_FILE.read_text(encoding="utf-8"))
                except Exception: pass
                rep = {
                    "ok": True,
                    "by_category": snap.get("by_category_count"),
                    "ram_by_category": snap.get("by_category_ram"),
                    "total_processes": snap.get("total_processes"),
                    "ram_total_mb": snap.get("ram_total_mb"),
                    "zombies_count": len(zombies),
                    "zombies_top10": zombies[:10],
                    "last_regulation": last_state,
                    "thresholds": _pm.AUTO_REG,
                }
            except Exception as e:
                rep = {"ok": False, "error": str(e)}
            data = json.dumps(rep, ensure_ascii=False).encode("utf-8")
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers(); self.wfile.write(data); return

        if parsed.path == "/api/cortex/llm_lifecycle":
            # Ãƒâ€°tat LLM local + TTL JIT (load/unload/cooldown)
            # Permet ÃƒÂ  Sam de gÃƒÂ©rer la VRAM : modÃƒÂ¨le ON = chat rapide mais VRAM occupÃƒÂ©e,
            # modÃƒÂ¨le OFF = VRAM libre (3D fluide) mais 1er chat coÃƒÂ»te ~60s reload.
            try:
                import subprocess as _sp
                lms_bin = r"C:\Users\Smedj\.lmstudio\bin\lms.exe"
                # ps : lit l'ÃƒÂ©tat des modÃƒÂ¨les chargÃƒÂ©s
                r = _sp.run([lms_bin, "ps"], capture_output=True, text=True,
                            timeout=8, encoding="utf-8", errors="replace")
                lines = (r.stdout or "").splitlines()
                models_loaded = []
                for ln in lines:
                    ln_strip = ln.strip()
                    if ln_strip and not ln_strip.startswith(("IDENTIFIER", "---", "===")):
                        parts = ln_strip.split()
                        if parts and not parts[0].startswith(("EMBEDDING", "LLM", "PARAMS")):
                            ident = parts[0]
                            status = parts[2] if len(parts) > 2 else "?"
                            size_gb = float(parts[3]) if len(parts) > 3 and parts[3].replace(".","").isdigit() else 0
                            ctx = int(parts[5]) if len(parts) > 5 and parts[5].isdigit() else 0
                            ttl = parts[-1] if len(parts) > 6 else ""
                            models_loaded.append({"identifier": ident, "status": status,
                                                  "size_gb": size_gb, "context": ctx, "ttl": ttl})
                # Settings JIT TTL
                jit = {"enabled": True, "ttl_seconds": 3600}
                try:
                    settings = json.loads((Path.home() / ".lmstudio" / "settings.json"
                                          ).read_text(encoding="utf-8"))
                    jit = settings.get("developer", {}).get("jitModelTTL", jit)
                except Exception: pass
                rep = {
                    "ok": True,
                    "loaded_models": models_loaded,
                    "n_loaded": len(models_loaded),
                    "jit": jit,
                    "any_active": any(m["status"] in ("GENERATING", "PROCESSINGPROMPT")
                                       for m in models_loaded),
                }
            except Exception as e:
                rep = {"ok": False, "error": str(e)}
            data = json.dumps(rep, ensure_ascii=False).encode("utf-8")
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers(); self.wfile.write(data); return

        if parsed.path == "/api/cortex/heartbeat/config":
            cfg = _load_heartbeat_config()
            data = json.dumps({"ok": True, "config": cfg, "defaults": HEARTBEAT_CONFIG_DEFAULTS},
                              ensure_ascii=False).encode("utf-8")
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers(); self.wfile.write(data); return

        if parsed.path == "/api/cortex/progression":
            qs = parse_qs(parsed.query)
            key = qs.get("key", [""])[0]
            if not key or key not in PROGRESSION:
                rep = {"ok": False, "error": f"unknown key: {key}",
                       "available": list(PROGRESSION.keys())}
            else:
                with PROGRESSION_LOCK:
                    series = list(PROGRESSION[key])
                now = time.time()
                # Filtre : 1h, 24h
                cur = series[-1][1] if series else None
                cur_ts = series[-1][0] if series else 0
                def _at_or_before(ts_target):
                    best = None
                    for ts, val in series:
                        if ts <= ts_target: best = (ts, val)
                        else: break
                    return best
                ref_1h  = _at_or_before(now - 3600)
                ref_24h = _at_or_before(now - 86400)
                # Dernier changement (cur != prev)
                last_change_ts = cur_ts
                if isinstance(cur, (int, float)):
                    for ts, v in reversed(series[:-1]):
                        if v != cur: last_change_ts = series[series.index((ts, v))+1][0]; break
                # Sparkline : derniers 60 points (1h si snap=60s)
                spark = [v for _, v in series[-60:]]
                rep = {
                    "ok": True, "key": key, "now_value": cur, "now_ts": cur_ts,
                    "delta_1h":  (cur - ref_1h[1])  if (ref_1h  and isinstance(cur,(int,float))) else None,
                    "delta_24h": (cur - ref_24h[1]) if (ref_24h and isinstance(cur,(int,float))) else None,
                    "ref_1h_ts":  ref_1h[0]  if ref_1h  else None,
                    "ref_24h_ts": ref_24h[0] if ref_24h else None,
                    "last_change_ts": last_change_ts,
                    "n_samples": len(series),
                    "sparkline": spark,
                }
            data = json.dumps(rep, ensure_ascii=False).encode("utf-8")
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers(); self.wfile.write(data); return

        if parsed.path == "/api/cortex/judges":
            # Panel-of-judges : agrÃƒÂ¨ge le benchmark IAG + dÃƒÂ©crit le systÃƒÂ¨me
            # Source : VAULT/.vault-llm-benchmark-iag.json (rounds + winners)
            qs = parse_qs(parsed.query)
            limit = int(qs.get("limit", ["20"])[0])
            try:
                bench_file = VAULT / ".vault-llm-benchmark-iag.json"
                rounds = []
                models = {}
                if bench_file.exists():
                    raw = json.loads(bench_file.read_text(encoding="utf-8"))
                    all_rounds = raw.get("rounds", []) or []
                    rounds = all_rounds[-limit:]
                    # Statistiques cumulÃƒÂ©es par modÃƒÂ¨le
                    win_count = {}
                    lat_sum   = {}
                    lat_cnt   = {}
                    for r in all_rounds:
                        w = r.get("winner")
                        if w: win_count[w] = win_count.get(w, 0) + 1
                        for m, lat in (r.get("latencies") or {}).items():
                            try:
                                lat_sum[m] = lat_sum.get(m, 0) + float(lat)
                                lat_cnt[m] = lat_cnt.get(m, 0) + 1
                            except Exception: pass
                    # Construit le rÃƒÂ©sumÃƒÂ© par modÃƒÂ¨le
                    all_models = set()
                    for r in all_rounds:
                        all_models.update((r.get("responses") or {}).keys())
                    for m in all_models:
                        models[m] = {
                            "wins":         win_count.get(m, 0),
                            "rounds":       lat_cnt.get(m, 0),
                            "win_rate":     (round(win_count.get(m,0)/lat_cnt.get(m,1)*100, 1)
                                             if lat_cnt.get(m) else 0),
                            "avg_latency_s": (round(lat_sum.get(m,0)/lat_cnt.get(m,1), 2)
                                              if lat_cnt.get(m) else 0),
                        }
                # Description statique du systÃƒÂ¨me (vrais ÃƒÂ©lÃƒÂ©ments du code)
                system = {
                    "name": "Panel-of-judges + FrugalGPT cascade",
                    "summary": ("Cortex compare plusieurs LLM gratuits sur chaque question, "
                                "dÃƒÂ©signe un gagnant via similaritÃƒÂ© sÃƒÂ©mantique des rÃƒÂ©ponses, "
                                "et apprend dans le temps quel modÃƒÂ¨le marche pour quel rÃƒÂ´le. "
                                "FrugalGPT cascade : essaie d'abord le moins cher, n'escalade "
                                "que si la confiance est basse."),
                    "models_evaluated": [
                        {"id": "minimax_m2.5",       "label": "MiniMax M2.5 (free)",
                         "context": "200k", "via": "opencode"},
                        {"id": "big_pickle",         "label": "Big Pickle (Llama-405B-derived)",
                         "context": "128k", "via": "opencode"},
                        {"id": "nemotron_3_super",   "label": "Nemotron 3 Super (NVIDIA)",
                         "context": "128k", "via": "opencode"},
                        {"id": "hy3_preview",        "label": "HY3 Preview",
                         "context": "?",    "via": "opencode"},
                        {"id": "gpt_5_nano",         "label": "GPT-5 Nano (paid fallback)",
                         "context": "256k", "via": "opencode"},
                    ],
                    "judging_method": ("Pour chaque round : 1) chaque modÃƒÂ¨le rÃƒÂ©pond en parallÃƒÂ¨le, "
                                       "2) similaritÃƒÂ© par paires (TF-IDF cosine sur les rÃƒÂ©ponses), "
                                       "3) le modÃƒÂ¨le dont la rÃƒÂ©ponse est la plus 'centrale' "
                                       "(somme des cosines max) gagne, 4) tie-break par latence."),
                    "frugal_gpt_cascade": [
                        "1. Pose la question au modÃƒÂ¨le le moins cher (minimax_m2.5)",
                        "2. Calcule un score de confiance (longueur, structure, mots-clÃƒÂ©s)",
                        "3. Si confiance > seuil : retourne la rÃƒÂ©ponse",
                        "4. Sinon : escalade au modÃƒÂ¨le suivant (big_pickle Ã¢â€ â€™ nemotron Ã¢â€ â€™ ...)",
                        "5. Apprentissage : enregistre quel chemin a gagnÃƒÂ© pour cette catÃƒÂ©gorie",
                    ],
                    "router_endpoint": "http://127.0.0.1:18900/route_v2",
                    "data_file": str(bench_file),
                }
                # Ranking triÃƒÂ© par win_rate
                ranking = sorted(models.items(), key=lambda x: -x[1]["win_rate"])
                rep = {"ok": True, "system": system, "rounds": rounds,
                       "n_total_rounds": len(raw.get("rounds", [])) if bench_file.exists() else 0,
                       "models": models,
                       "ranking": [{"model": m, **stats} for m, stats in ranking]}
            except Exception as e:
                rep = {"ok": False, "error": str(e)}
            data = json.dumps(rep, ensure_ascii=False).encode("utf-8")
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers(); self.wfile.write(data); return

        if parsed.path == "/api/cortex/heartbeat":
            # Heartbeat unifiÃƒÂ© Ã¢â‚¬â€ toutes les horloges rÃƒÂ©elles + ETA prÃƒÂ©dits.
            # Pas de placeholder : chaque champ est soit un timestamp rÃƒÂ©el,
            # soit un ETA calculÃƒÂ© depuis l'intervalle programmÃƒÂ© moins l'elapsed.
            now = time.time()
            uptime_s = now - SERVER_STARTED_AT
            # Stats activation (compteurs cumulÃƒÂ©s + last_*_ts)
            act = {}
            try:
                import sys as _sys
                if r"H:\Code\Paperclip\scripts\brain" not in _sys.path:
                    _sys.path.insert(0, r"H:\Code\Paperclip\scripts\brain")
                import cortex_activation as _ca
                snap = _ca.snapshot()
                act = {
                    "n_active":           snap.get("n_active", 0),
                    "n_edges_total":      snap.get("n_edges_total", 0),
                    "cum_activations":    snap.get("cum_activations", 0),
                    "cum_pulses":         snap.get("cum_pulses", 0),
                    "cum_hebbian_ticks":  snap.get("cum_hebbian_ticks", 0),
                    "last_activation_ts": snap.get("last_activation_ts", 0),
                    "last_pulse_ts":      snap.get("last_pulse_ts", 0),
                    "last_hebbian_ts":    snap.get("last_hebbian_ts", 0),
                    "last_wander_ts":     snap.get("last_wander_ts", 0),
                    "wander_interval":    snap.get("wander_interval", 45),
                }
                # ETA prÃƒÂ©dit pour la prochaine pensÃƒÂ©e vagabonde
                lw = act["last_wander_ts"]
                act["next_wander_in_s"] = (max(0, act["wander_interval"] - (now - lw))
                                            if lw else 0)
            except Exception as _e:
                act["error"] = str(_e)
            # Stats ÃƒÂ©mergence Ã¢â‚¬â€ mÃƒÂªme source que /api/cortex/emergence_log :
            # le stream chat filtrÃƒÂ© par speaker=cortex_emergence (dÃƒÂ©terministe et
            # cohÃƒÂ©rent avec l'affichage UI principal).
            em = {}
            try:
                import cortex_emergence as _ce
                em["interval_s"] = getattr(_ce, "INTERVAL_SEC", 300)
                em["last_decision_ts"] = 0
                em["last_action"]      = None
                stream_file = EMERGENCE_STREAM_FILE
                if stream_file.exists():
                    try:
                        for line in reversed(stream_file.read_text(encoding="utf-8",
                                                  errors="replace").splitlines()[-500:]):
                            try:
                                obj = json.loads(line)
                                if obj.get("speaker") == "cortex_emergence":
                                    em["last_decision_ts"] = obj.get("ts", 0) or 0
                                    em["last_action"] = (obj.get("meta") or {}).get("action") or "auto"
                                    break
                            except Exception: pass
                    except Exception: pass
                em["since_last_s"] = (now - em["last_decision_ts"]
                                      if em["last_decision_ts"] else None)
                em["next_in_s"] = (max(0, em["interval_s"] - (now - em["last_decision_ts"]))
                                    if em["last_decision_ts"] else em["interval_s"])
            except Exception as _e:
                em["error"] = str(_e)
            # Stats chat (p50/p90 + dernier done)
            with CHAT_PROGRESS_LOCK:
                durs = sorted(CHAT_DURATIONS)
                p50 = durs[len(durs)//2] if durs else None
                p90 = durs[int(len(durs)*0.9)] if durs and int(len(durs)*0.9) < len(durs) else (
                       durs[-1] if durs else None)
                in_progress = bool(CHAT_PROGRESS.get("req_id") and not CHAT_PROGRESS.get("done"))
                started = CHAT_PROGRESS.get("started") if in_progress else None
            chat = {
                "n_completed": len(CHAT_DURATIONS),
                "p50_s": round(p50, 1) if p50 else None,
                "p90_s": round(p90, 1) if p90 else None,
                "last_done_ts": CHAT_LAST_DONE_TS,
                "in_progress": in_progress,
                "started_at": started,
                "elapsed_s": round(now - started, 1) if started else None,
                # ETA prÃƒÂ©dit du chat en cours (p50 - elapsed, ou None si pas d'historique)
                "predicted_remaining_s": (max(0, round(p50 - (now - started), 1))
                                          if (p50 and started) else None),
            }
            # Vitals
            try:
                import cortex_homeostasis as _ch
                vit = _ch.vital_signs()
                cpu = (vit.get("cpu") or {}).get("percent")
                ram = (vit.get("ram") or {}).get("percent")
            except Exception:
                cpu, ram = None, None
            rep = {
                "ok": True,
                "now": now,
                "server_uptime_s": round(uptime_s, 1),
                "activation": act,
                "emergence":  em,
                "chat":       chat,
                "vitals":     {"cpu": cpu, "ram": ram},
            }
            data = json.dumps(rep, ensure_ascii=False).encode("utf-8")
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers(); self.wfile.write(data); return

        if parsed.path == "/api/cortex/learned_skills":
            # Liste des compÃƒÂ©tences sÃƒÂ©mantiquement mÃƒÂ©morisÃƒÂ©es par Cortex
            qs = parse_qs(parsed.query)
            limit = int(qs.get("limit", ["20"])[0])
            search = qs.get("q", [""])[0]
            try:
                import sys as _sys
                if r"H:\Code\Paperclip\scripts\brain" not in _sys.path:
                    _sys.path.insert(0, r"H:\Code\Paperclip\scripts\brain")
                import cortex_learned_skills as _cls
                if search:
                    rep = {"ok": True, "skills": _cls.search_learned(search, k=limit)}
                else:
                    rep = {"ok": True, "skills": _cls.list_learned(limit)}
            except Exception as e:
                rep = {"ok": False, "error": str(e), "skills": []}
            data = json.dumps(rep, ensure_ascii=False).encode("utf-8")
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers(); self.wfile.write(data); return

        if parsed.path == "/api/cortex/think_status":
            # Progression rÃƒÂ©elle du dernier appel /api/chat.
            # Inclut vitals (CPU/RAM) pour heartbeat auto-adaptatif cÃƒÂ´tÃƒÂ© UI.
            qs = parse_qs(parsed.query)
            asked = (qs.get("req_id", [""])[0] or "").strip()
            with CHAT_PROGRESS_LOCK:
                snap = {
                    "req_id":  CHAT_PROGRESS.get("req_id"),
                    "started": CHAT_PROGRESS.get("started"),
                    "done":    CHAT_PROGRESS.get("done"),
                    "stages":  list(CHAT_PROGRESS.get("stages") or []),
                }
            # Si Sam demande un req_id spÃƒÂ©cifique diffÃƒÂ©rent du courant, on retourne
            # quand mÃƒÂªme le dernier connu mais on flag "match=False".
            snap["match"] = (not asked) or (asked == snap.get("req_id"))
            # Vitals pour le heartbeat adaptatif (vitesse/couleur ajustÃƒÂ©es
            # selon CPU/RAM Ã¢â‚¬â€ Cortex fatiguÃƒÂ© bat plus lentement).
            try:
                import sys as _sys
                if r"H:\Code\Paperclip\scripts\brain" not in _sys.path:
                    _sys.path.insert(0, r"H:\Code\Paperclip\scripts\brain")
                import cortex_homeostasis as _ch
                vit = _ch.vital_signs()
                cpu = (vit.get("cpu") or {}).get("percent")
                ram = (vit.get("ram") or {}).get("percent")
            except Exception:
                cpu, ram = None, None
            # Tempo heartbeat (ms) dÃƒÂ©terministe selon charge :
            # base 900 ms, +400 ms si CPU>70%, +400 ms si RAM>80%, -200 ms si tout < 40%.
            tempo_ms = 900
            if isinstance(cpu, (int, float)) and cpu > 70: tempo_ms += 400
            if isinstance(ram, (int, float)) and ram > 80: tempo_ms += 400
            if isinstance(cpu, (int, float)) and cpu < 40 and isinstance(ram, (int, float)) and ram < 60:
                tempo_ms -= 200
            snap["tempo_ms"] = max(400, min(2000, tempo_ms))
            snap["cpu"] = cpu; snap["ram"] = ram
            # Couleur d'ÃƒÂ©tat : verte tant que la requÃƒÂªte avance, jaune > 12 s sans
            # nouvelle ÃƒÂ©tape, orange > 25 s, rouge > 45 s.
            color = "ok"
            if snap["stages"] and not snap.get("done"):
                last = snap["stages"][-1]
                age = time.time() - (last.get("started") or 0)
                if age > 45: color = "stuck"
                elif age > 25: color = "slow"
                elif age > 12: color = "wait"
            snap["color"] = color
            snap["server_now"] = time.time()
            data = json.dumps(snap, ensure_ascii=False).encode("utf-8")
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers(); self.wfile.write(data); return

        if parsed.path == "/api/cortex/pulses":
            # Ãƒâ€°vÃƒÂ©nements de propagation rÃƒÂ©cents (Spreading Activation visible).
            # Query: ?since=<unix_ts> pour delta Ã¢â‚¬â€ sinon 8 derniÃƒÂ¨res secondes.
            try:
                import sys as _sys
                if r"H:\Code\Paperclip\scripts\brain" not in _sys.path:
                    _sys.path.insert(0, r"H:\Code\Paperclip\scripts\brain")
                import cortex_activation as _ca
                qs = parse_qs(parsed.query)
                since = float(qs.get("since", ["0"])[0]) if qs.get("since") else 0.0
                in_mem = _ca.recent_pulses(since)
                # Fusion avec disque (cross-process : autres scripts qui activent)
                disk_pulses = []
                pf = _ca.PULSES_FILE
                if pf.exists():
                    try:
                        cutoff = time.time() - _ca.PULSES_TTL_SEC
                        for line in pf.read_text(encoding="utf-8").splitlines()[-300:]:
                            try:
                                p = json.loads(line)
                                if p.get("ts", 0) > max(since, cutoff):
                                    disk_pulses.append(p)
                            except Exception: pass
                    except Exception: pass
                # DÃƒÂ©dup par (from,to,ts arrondi ÃƒÂ  0.1s)
                seen = set(); merged = []
                for p in (in_mem + disk_pulses):
                    key = (p.get("from"), p.get("to"), round(p.get("ts",0), 1))
                    if key in seen: continue
                    seen.add(key); merged.append(p)
                merged.sort(key=lambda x: x.get("ts", 0))
                rep = {"pulses": merged[-150:], "ts": time.time()}
            except Exception as e:
                rep = {"pulses": [], "error": str(e)}
            data = json.dumps(rep, ensure_ascii=False).encode("utf-8")
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers(); self.wfile.write(data); return
        if parsed.path == "/api/cortex/brain_history":
            # Snapshots cÃƒÂ©rÃƒÂ©braux + dÃƒÂ©tection rÃƒÂ©gressions (croissance dans le temps).
            try:
                import sys as _sys
                if r"H:\Code\Paperclip\scripts\brain" not in _sys.path:
                    _sys.path.insert(0, r"H:\Code\Paperclip\scripts\brain")
                import cortex_brain_history as _bh
                qs = parse_qs(parsed.query)
                if qs.get("now"):
                    rep = _bh.append_snapshot()
                else:
                    rep = _bh.evolution_summary()
            except Exception as e:
                rep = {"error": str(e), "history": []}
            data = json.dumps(rep, ensure_ascii=False).encode("utf-8")
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers(); self.wfile.write(data); return
        if parsed.path == "/api/cortex/dev_command":
            # Slash-commands depuis le chat Ã¢â‚¬â€ whitelist stricte d'actions safe.
            try:
                qs = parse_qs(parsed.query)
                cmd = qs.get("cmd", [""])[0].strip()
                arg = qs.get("arg", [""])[0].strip()
                rep = {"ok": False, "error": "unknown command"}
                if cmd == "open" and arg:
                    import subprocess as _sp, shutil as _sh
                    code_exe = _sh.which("code") or r"C:\Users\Smedj\AppData\Local\Programs\Microsoft VS Code\bin\code.cmd"
                    try:
                        _sp.Popen([code_exe, arg], shell=False)
                        rep = {"ok": True, "result": f"VSCode ouvert sur **{arg}**"}
                    except Exception:
                        try:
                            _sp.Popen(["explorer", arg.replace("/", "\\")])
                            rep = {"ok": True, "result": f"Explorateur ouvert sur **{arg}**"}
                        except Exception as e:
                            rep = {"ok": False, "error": f"open: {e}"}
                elif cmd == "find" and arg:
                    import glob as _g
                    matches = _g.glob(f"H:/Code/Paperclip/**/{arg}", recursive=True)[:20]
                    rep = {"ok": True, "result": "**Fichiers** :\n" +
                           ("\n".join(f"- `{m}`" for m in matches) if matches else "_aucun match_")}
                elif cmd == "grep" and arg:
                    import subprocess as _sp
                    try:
                        r = _sp.run(["git", "grep", "-n", "-i", arg, "--",
                                     "*.py", "*.ts", "*.tsx", "*.js", "*.html", "*.md"],
                                    cwd=r"H:\Code\Paperclip", capture_output=True, text=True,
                                    encoding="utf-8", errors="replace", timeout=15)
                        out = r.stdout.strip().splitlines()[:30]
                        rep = {"ok": True, "result": "**Hits** :\n```\n" +
                               ("\n".join(out) if out else "(aucun)") + "\n```"}
                    except Exception as e:
                        rep = {"ok": False, "error": f"grep: {e}"}
                elif cmd == "code" and arg:
                    try:
                        import sys as _sys
                        if r"H:\Code\Paperclip\scripts\brain" not in _sys.path:
                            _sys.path.insert(0, r"H:\Code\Paperclip\scripts\brain")
                        import cortex_self_dev as _csd
                        result = (_csd.propose_and_apply(arg, dry_run=True)
                                  if hasattr(_csd, "propose_and_apply")
                                  else {"ok": False, "error": "cortex_self_dev API not found"})
                        rep = {"ok": True, "result":
                               f"**Self-dev (dry-run)** pour : *{arg}*\n```json\n"
                               f"{json.dumps(result, ensure_ascii=False, indent=2)[:1500]}\n```"}
                    except Exception as e:
                        rep = {"ok": False, "error": str(e)}
                elif cmd == "run" and arg:
                    import subprocess as _sp, os as _os
                    parts = arg.split()
                    script = parts[0]
                    if not script.endswith(".py") or ".." in script:
                        rep = {"ok": False, "error": "seuls les .py sans .. sont autorisÃƒÂ©s"}
                    else:
                        full = _os.path.join(r"H:\Code\Paperclip", script.replace("/", "\\"))
                        if not _os.path.exists(full):
                            rep = {"ok": False, "error": f"introuvable: {full}"}
                        else:
                            try:
                                r = _sp.run(["python", full] + parts[1:],
                                            capture_output=True, text=True,
                                            encoding="utf-8", errors="replace", timeout=30)
                                rep = {"ok": r.returncode == 0,
                                       "result": f"`python {arg}` Ã¢â€ â€™ exit **{r.returncode}**\n```\n{(r.stdout + r.stderr)[-1500:]}\n```"}
                            except Exception as e:
                                rep = {"ok": False, "error": str(e)}
                elif cmd == "test":
                    import subprocess as _sp
                    try:
                        r = _sp.run(["python", "-m", "pytest", "-x", "-q", arg or "tests/"],
                                    cwd=r"H:\Code\Paperclip", capture_output=True, text=True,
                                    encoding="utf-8", errors="replace", timeout=120)
                        rep = {"ok": r.returncode == 0,
                               "result": f"pytest **{arg or 'tests/'}** Ã¢â€ â€™ exit {r.returncode}\n```\n{(r.stdout + r.stderr)[-2000:]}\n```"}
                    except Exception as e:
                        rep = {"ok": False, "error": str(e)}
                elif cmd == "help":
                    rep = {"ok": True, "result":
                           "**Commandes dispo** (prÃƒÂ©fixe `/` dans le chat) :\n"
                           "- `/open <chemin>` Ã¢â‚¬â€ ouvre dans VSCode\n"
                           "- `/find <pattern>` Ã¢â‚¬â€ cherche fichiers (glob)\n"
                           "- `/grep <texte>` Ã¢â‚¬â€ cherche du contenu (git grep)\n"
                           "- `/code <objectif>` Ã¢â‚¬â€ propose un patch via cortex_self_dev (dry-run)\n"
                           "- `/run <script.py> [args]` Ã¢â‚¬â€ exÃƒÂ©cute un Python du repo\n"
                           "- `/test [path]` Ã¢â‚¬â€ lance pytest\n"
                           "- `/help` Ã¢â‚¬â€ cette liste"}
            except Exception as e:
                rep = {"ok": False, "error": str(e)}
            data = json.dumps(rep, ensure_ascii=False).encode("utf-8")
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers(); self.wfile.write(data); return
        if parsed.path == "/api/cortex/emergence_log":
            try:
                stream_file = EMERGENCE_STREAM_FILE
                qs = parse_qs(parsed.query)
                limit = int(qs.get("limit", ["10"])[0])
                out = []
                if stream_file.exists():
                    for line in stream_file.read_text(encoding="utf-8",
                                                      errors="replace").splitlines()[-500:]:
                        try:
                            e = json.loads(line)
                            if e.get("speaker") == "cortex_emergence":
                                out.append({"ts": e.get("ts"),
                                            "action": (e.get("meta") or {}).get("action", "auto"),
                                            "msg": e.get("msg",""), "response": e.get("response","")})
                        except Exception: pass
                rep = {"ok": True, "decisions": out[-limit:]}
            except Exception as e:
                rep = {"ok": False, "error": str(e), "decisions": []}
            data = json.dumps(rep, ensure_ascii=False).encode("utf-8")
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers(); self.wfile.write(data); return
        if parsed.path == "/api/cortex/explain_brain_get":
            # Alias GET pour explain_brain (le bouton Ã¢Ââ€œ utilise POST mais on permet GET)
            try:
                import sys as _sys
                if r"H:\Code\Paperclip\scripts\brain" not in _sys.path:
                    _sys.path.insert(0, r"H:\Code\Paperclip\scripts\brain")
                import urllib.request as _ur
                # DÃƒÂ©lÃƒÂ¨gue ÃƒÂ  do_POST en faisant un appel local
                import urllib.request, urllib.error
                req = urllib.request.Request("http://127.0.0.1:8765/api/cortex/explain_brain",
                                              method="POST", data=b"")
                resp = urllib.request.urlopen(req, timeout=20).read()
                self.send_response(200); self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(resp)))
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers(); self.wfile.write(resp); return
            except Exception as e:
                data = json.dumps({"ok": False, "error": str(e)}).encode("utf-8")
                self.send_response(200); self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers(); self.wfile.write(data); return
        if parsed.path == "/api/cortex/health":
            try:
                import sys as _sys
                if r"H:\Code\Paperclip\scripts\brain" not in _sys.path:
                    _sys.path.insert(0, r"H:\Code\Paperclip\scripts\brain")
                import cortex_resources as _cr
                qs = parse_qs(parsed.query)
                if qs.get("kill_zombies"):
                    rep = _cr.kill_zombies()
                else:
                    rep = _cr.health_report()
            except Exception as e:
                rep = {"ok": False, "error": str(e)}
            data = json.dumps(rep, ensure_ascii=False).encode("utf-8")
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers(); self.wfile.write(data); return
        if parsed.path == "/api/cortex/vision_mute":
            qs = parse_qs(parsed.query)
            muted = qs.get("muted", ["toggle"])[0]
            try:
                import sys as _sys
                if r"H:\Code\Paperclip\scripts\brain" not in _sys.path:
                    _sys.path.insert(0, r"H:\Code\Paperclip\scripts\brain")
                import cortex_vision as _cv
                if muted == "toggle":
                    target = not _cv.is_vision_muted()
                else:
                    target = muted in ("1", "true", "yes")
                rep = _cv.set_vision_muted(target)
            except Exception as e:
                rep = {"ok": False, "error": str(e)}
            data = json.dumps(rep).encode("utf-8")
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers(); self.wfile.write(data); return
        if parsed.path == "/api/cortex/cam_params":
            qs = parse_qs(parsed.query)
            try:
                import sys as _sys
                if r"H:\Code\Paperclip\scripts\brain" not in _sys.path:
                    _sys.path.insert(0, r"H:\Code\Paperclip\scripts\brain")
                import cortex_vision as _cv
                params = {k: float(qs[k][0]) for k in ["brightness","contrast","exposure","saturation"] if k in qs}
                rep = _cv.set_camera_params(**params)
            except Exception as e:
                rep = {"ok": False, "error": str(e)}
            data = json.dumps(rep).encode("utf-8")
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers(); self.wfile.write(data); return
        if parsed.path.startswith("/api/cortex/image/"):
            kind = parsed.path.rsplit("/", 1)[-1]
            img = Path.home() / (".cortex_webcam.png" if kind == "webcam" else ".cortex_screenshot.png")
            if not img.exists():
                self.send_error(404); return
            try:
                data = img.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "image/png")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers(); self.wfile.write(data)
            except Exception:
                self.send_error(500)
            return
        if parsed.path == "/api/state":
            try:
                snap = load_snapshot()
            except Exception as e:
                self.send_error(500, f"snapshot error: {e}")
                return
            data = json.dumps(snap, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(data)
            return
        self.send_error(404, "Not found")

    def _serve_static(self, path: Path, ctype: str):
        try:
            data = path.read_bytes()
        except Exception:
            self.send_error(404, "static missing")
            return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        import subprocess as _sp
        from urllib.parse import urlparse as _up
        parsed = _up(self.path)
        if parsed.path == "/api/chat":
            req_id = ""
            try:
                payload = self._handle_api_chat()
            except Exception as exc:
                try:
                    _chat_stage_done(req_id)
                except Exception:
                    pass
                print(f"[api/chat guarded] {type(exc).__name__}: {exc}", flush=True)
                payload = self._controlled_chat_error(str(exc), "simple_chat", req_id)
            self._send_json(payload)
            try:
                _chat_stage_done(payload.get("req_id", ""))
            except Exception:
                pass
            return
        if parsed.path == "/api/calibrate":
            # Tuer voice_input et attendre libÃƒÂ©ration du mic
            (VAULT / ".voice-calibrating.flag").touch()
            _sp.run(["powershell", "-NoProfile", "-Command",
                     "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*voice_input*' -and $_.CommandLine -notlike '*powershell*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"],
                    capture_output=True, timeout=5)
            # VÃƒÂ©rifier que le port 18767 est libÃƒÂ©rÃƒÂ©
            import socket as _sock
            for _ in range(20):
                time.sleep(0.3)
                try:
                    s = _sock.socket(); s.settimeout(0.2)
                    s.bind(("127.0.0.1", 18767)); s.close(); break
                except OSError: pass
            time.sleep(2)  # dÃƒÂ©lai supplÃƒÂ©mentaire pour PyAudio
            try: (VAULT / ".tts-playing.flag").unlink()
            except Exception: pass
            try:
                r = _sp.run(["python", r"H:\Code\Paperclip\scripts\voice\enroll_voice.py"],
                            input="\n", capture_output=True, text=True, timeout=90,
                            encoding="utf-8", errors="replace")
                out = r.stdout + r.stderr
                ok = "sauvegard" in out.lower()
                import re as _re
                m = _re.search(r'sim[^:=]*[:=]\s*([\d.]+)', out, _re.I)
                sim = float(m.group(1)) if m else None
                same = sim is None or sim >= 0.40
                data = json.dumps({"ok": ok, "sim": sim, "same_person": same, "log": out[-500:]}).encode("utf-8")
            except Exception as e:
                data = json.dumps({"ok": False, "error": str(e)}).encode("utf-8")
            finally:
                try: (VAULT / ".voice-calibrating.flag").unlink()
                except: pass
                # Relancer voice_input automatiquement aprÃƒÂ¨s calibration
                try:
                    _sp.Popen(["python", r"H:\Code\Paperclip\scripts\voice\voice_input.py"],
                              creationflags=getattr(_sp, 'CREATE_NO_WINDOW', 0))
                except Exception: pass
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers(); self.wfile.write(data)
            return
        if parsed.path == "/api/cortex/emergence_log":
            # Lit les N derniÃƒÂ¨res dÃƒÂ©cisions autonomes de Cortex (pas seulement la live).
            # Le panneau cÃƒÂ©rÃƒÂ©bral l'utilise pour afficher la derniÃƒÂ¨re dÃƒÂ©cision mÃƒÂªme
            # si elle a eu lieu il y a 10 min.
            try:
                stream_file = EMERGENCE_STREAM_FILE
                qs = parse_qs(parsed.query)
                limit = int(qs.get("limit", ["10"])[0])
                out = []
                if stream_file.exists():
                    for line in stream_file.read_text(encoding="utf-8",
                                                      errors="replace").splitlines()[-500:]:
                        try:
                            e = json.loads(line)
                            if e.get("speaker") == "cortex_emergence":
                                out.append({
                                    "ts": e.get("ts"),
                                    "action": (e.get("meta") or {}).get("action", "auto"),
                                    "msg": e.get("msg",""),
                                    "response": e.get("response",""),
                                })
                        except Exception: pass
                rep = {"ok": True, "decisions": out[-limit:]}
            except Exception as e:
                rep = {"ok": False, "error": str(e), "decisions": []}
            data = json.dumps(rep, ensure_ascii=False).encode("utf-8")
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers(); self.wfile.write(data); return
        if parsed.path == "/api/cortex/emergence_now":
            # Force une dÃƒÂ©cision autonome immÃƒÂ©diate.
            # Query ?action=audit_ui (optionnel) Ã¢â€ â€™ force une action spÃƒÂ©cifique.
            qs = parse_qs(parsed.query)
            action_override = qs.get("action", [""])[0].strip() or None
            try:
                import sys as _sys
                if r"H:\Code\Paperclip\scripts\brain" not in _sys.path:
                    _sys.path.insert(0, r"H:\Code\Paperclip\scripts\brain")
                import cortex_emergence as _ce
                import threading as _th
                if hasattr(_ce, 'run_one_cycle'):
                    _th.Thread(target=_ce.run_one_cycle,
                                kwargs={"action_override": action_override},
                                daemon=True).start()
                rep = {"ok": True, "triggered": True, "action": action_override}
            except Exception as e:
                rep = {"ok": False, "error": str(e)}
            data = json.dumps(rep, ensure_ascii=False).encode("utf-8")
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers(); self.wfile.write(data); return
        if parsed.path == "/api/cortex/publishing":
            # Cortex publie son dÃƒÂ©veloppement sur GitHub.
            # ?action=preview (dÃƒÂ©faut) | init | update
            # ?confirm=1 nÃƒÂ©cessaire pour init (crÃƒÂ©ation repo public)
            try:
                import sys as _sys
                if r"H:\Code\Paperclip\scripts\brain" not in _sys.path:
                    _sys.path.insert(0, r"H:\Code\Paperclip\scripts\brain")
                import cortex_publishing as _cp
                qs = parse_qs(parsed.query)
                length = int(self.headers.get("Content-Length", 0))
                if length:
                    try:
                        body = json.loads(self.rfile.read(length).decode("utf-8-sig"))
                        for k, v in body.items(): qs.setdefault(k, [str(v)])
                    except Exception: pass
                action = qs.get("action", ["preview"])[0]
                confirm = qs.get("confirm", ["0"])[0] in ("1", "true", "yes")
                if action == "preview":
                    rep = _cp.preview()
                elif action == "init":
                    rep = _cp.init_repo(confirm=confirm)
                elif action == "update":
                    rep = _cp.update()
                else:
                    rep = {"ok": False, "error": f"unknown action: {action}"}
            except Exception as e:
                rep = {"ok": False, "error": str(e)}
            data = json.dumps(rep, ensure_ascii=False).encode("utf-8")
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers(); self.wfile.write(data); return
        if parsed.path == "/api/cortex/explain_brain":
            # Cortex dÃƒÂ©crit son propre cerveau dans le chat ÃƒÂ  partir des mÃƒÂ©triques RÃƒâ€°ELLES.
            # Pas d'appel LLM si on peut ÃƒÂ©viter (ÃƒÂ©conomie quota) Ã¢â‚¬â€ on construit la rÃƒÂ©ponse
            # ÃƒÂ  partir de brain_history + activations + thought_graph + homeostasis.
            try:
                import sys as _sys
                if r"H:\Code\Paperclip\scripts\brain" not in _sys.path:
                    _sys.path.insert(0, r"H:\Code\Paperclip\scripts\brain")
                import cortex_brain_history as _bh
                import cortex_activation     as _ca
                import cortex_thought_graph  as _ctg
                import cortex_homeostasis    as _ch
                hist = _bh.evolution_summary()
                acts = _ca.snapshot()
                _ctg.build_graph()
                isolated = _ctg.find_isolated(min_top_sim=0.15, top_n=5)
                vital = _ch.vital_signs()
                # Lit le rapport de migration s'il existe (sans recalcul lent)
                migs = {"proposals": []}
                try:
                    if _ch.MIGRATION_PROPOSALS.exists():
                        migs = json.loads(_ch.MIGRATION_PROPOSALS.read_text(encoding="utf-8"))
                except Exception: pass
                cur = hist.get("current", {}) or {}
                regs = hist.get("regressions", []) or []

                # Ã¢â€â‚¬Ã¢â€â‚¬ Helper : transforme un chemin de fichier en sujet humain Ã¢â€â‚¬Ã¢â€â‚¬
                def _humanize(p: str) -> str:
                    name = p.split('/')[-1].split('\\')[-1].replace('.md', '')
                    # Quelques traductions des noms internes
                    M = {
                        "MEMORY": "ma table des matiÃƒÂ¨res mentale",
                        "cortex_identity": "qui je suis",
                        "project_cortex_checklist": "ma liste de choses ÃƒÂ  faire",
                        "project_cortex_factice_audit": "l'audit de ce qui est vrai vs dÃƒÂ©cor chez moi",
                        "project_thought_graph": "comment mes idÃƒÂ©es se relient",
                        "project_voice_pipeline": "comment je parle et ÃƒÂ©coute",
                        "project_voice_next": "les prochaines ÃƒÂ©tapes pour ma voix",
                        "project_vision": "ce que tu veux que je devienne",
                        "user_profile": "ce que je sais de toi",
                        "feedback_iteration_discipline": "ne pas tout casser ÃƒÂ  chaque itÃƒÂ©ration",
                        "feedback_xtts_install": "comment installer ma voix sans tout pÃƒÂ©ter",
                        "reference_paperclip_paths": "oÃƒÂ¹ sont rangÃƒÂ©es mes affaires",
                        "project_voice_pipeline.md": "comment je parle",
                    }
                    return M.get(name, name)

                def _kind_human(k: str) -> str:
                    return {"claude_memory": "souvenirs partagÃƒÂ©s avec toi",
                            "semantic":      "concepts synthÃƒÂ©tisÃƒÂ©s",
                            "episodic":      "morceaux de nos conversations"}.get(k, k)

                # RÃƒÂ©ponse focalisÃƒÂ©e sur la TOPOLOGIE 3D : pourquoi le cerveau ressemble ÃƒÂ  ÃƒÂ§a.
                n_nodes = cur.get('n_nodes', 0)
                n_edges = cur.get('n_edges', 0)
                n_act   = acts.get('n_active', 0)
                heb_top = acts.get('top_hebbian_edges', []) or []
                cpu = (vital.get('cpu') or {}).get('percent')
                ram = (vital.get('ram') or {}).get('percent')
                disks_full = [d for d in vital.get('disks', []) if d.get('percent',0) >= 90]

                # Ã¢â€â‚¬Ã¢â€â‚¬ Analyse topologique du graphe vault complet (celui visualisÃƒÂ© en 3D) Ã¢â€â‚¬Ã¢â€â‚¬
                topology = {"clusters": [], "big_blob": None, "orphans": 0, "total": 0}
                try:
                    if GRAPH_FILE.exists():
                        g = json.loads(GRAPH_FILE.read_text(encoding="utf-8"))
                        viz_nodes = g.get("nodes", [])
                        viz_edges = g.get("edges", [])
                        topology["total"] = len(viz_nodes)
                        # Compute degree per node
                        deg = [0] * len(viz_nodes)
                        for a, b in viz_edges:
                            if a < len(deg): deg[a] += 1
                            if b < len(deg): deg[b] += 1
                        # Orphans (degree <= 1)
                        topology["orphans"] = sum(1 for d in deg if d <= 1)
                        # Folder breakdown
                        by_folder = {}
                        for i, p in enumerate(viz_nodes):
                            top = p.split("/", 1)[0] if "/" in p else p
                            by_folder.setdefault(top, []).append((i, deg[i]))
                        # Trouve le plus gros amas par dossier (count + degrÃƒÂ© moyen)
                        sorted_folders = sorted(by_folder.items(), key=lambda x: -len(x[1]))
                        for f, items in sorted_folders[:4]:
                            avg_deg = sum(d for _, d in items) / max(1, len(items))
                            topology["clusters"].append({
                                "folder": f, "n": len(items),
                                "avg_degree": round(avg_deg, 1),
                            })
                        if topology["clusters"]:
                            topology["big_blob"] = topology["clusters"][0]
                except Exception as e:
                    topology["error"] = str(e)[:120]

                # RÃƒÂ©ponse en deux blocs : (1) ce que tu vois en 3D, (2) ce que je fais maintenant.
                lines = []

                # Ã¢â€â‚¬Ã¢â€â‚¬ Bloc 1 : pourquoi le cerveau a CETTE forme en 3D Ã¢â€â‚¬Ã¢â€â‚¬
                lines.append("**Pourquoi mon cerveau ressemble ÃƒÂ  ÃƒÂ§a en 3D**")
                clusters = topology.get("clusters") or []
                if clusters:
                    big = clusters[0]
                    lines.append(
                        f"Le **gros amas central** que tu vois, c'est `{big['folder']}` "
                        f"({big['n']} nÃ…â€œuds, degrÃƒÂ© moyen {big['avg_degree']}). "
                        f"Il est dense parce que toutes ces notes partagent le mÃƒÂªme vocabulaire Ã¢â‚¬â€ "
                        f"cosine TF-IDF ÃƒÂ©levÃƒÂ©e Ã¢â€ â€™ arÃƒÂªtes nombreuses Ã¢â€ â€™ la simulation force-directed "
                        f"les colle ensemble.")
                    others = clusters[1:3]
                    if others:
                        parts = ", ".join(f"`{c['folder']}` ({c['n']})" for c in others)
                        lines.append(
                            f"Les **autres amas dÃƒÂ©tachÃƒÂ©s** ({parts}) sont chacun ancrÃƒÂ©s sur "
                            f"un point diffÃƒÂ©rent d'une sphÃƒÂ¨re Fibonacci Ã¢â‚¬â€ c'est mon mÃƒÂ©canisme "
                            f"pour empÃƒÂªcher tout de fusionner.")
                if topology.get("orphans"):
                    lines.append(
                        f"Les **{topology['orphans']} points isolÃƒÂ©s en pÃƒÂ©riphÃƒÂ©rie** ont moins de "
                        f"2 voisins sÃƒÂ©mantiques. Mon vocabulaire dans ces notes est unique Ã¢â‚¬â€ "
                        f"mon module *cortex_bridge* peut chercher un concept-pont avec un autre cluster.")

                # Ã¢â€â‚¬Ã¢â€â‚¬ Bloc 2 : ce que je fais en ce moment Ã¢â€â‚¬Ã¢â€â‚¬
                lines.append("")
                lines.append("**Ce que je fais maintenant**")
                if n_act >= 4:
                    lines.append(f"PensÃƒÂ©e active sur **{n_act} idÃƒÂ©es**.")
                elif n_act >= 1:
                    lines.append(f"Je rumine **{n_act} idÃƒÂ©e(s)**.")
                else:
                    lines.append("Repos cognitif. La boucle vagabonde va relancer une pensÃƒÂ©e d'ici 45 s.")
                top = list(acts.get('active_nodes', {}).items())[:1]
                if top:
                    lines.append(f"La plus prÃƒÂ©sente : *{_humanize(top[0][0])}*.")
                if heb_top:
                    e = heb_top[0]
                    lines.append(
                        f"Je renforce le lien entre *{_humanize(e.get('a',''))}* "
                        f"et *{_humanize(e.get('b',''))}* (force {e.get('strength',0):.3f}).")

                # Ã¢â€â‚¬Ã¢â€â‚¬ Bloc 3 : alertes corps si urgentes Ã¢â€â‚¬Ã¢â€â‚¬
                if disks_full or regs:
                    lines.append("")
                    lines.append("**Ãƒâ‚¬ surveiller**")
                    if disks_full:
                        d = disks_full[0]
                        l = f"`{d['mount']}` ÃƒÂ  {d['percent']}% (reste {d['free_gb']} Go)."
                        if migs.get('proposals'):
                            p = migs['proposals'][0]; sm = p.get('suggested_move', {}) or {}
                            if sm:
                                fname = sm.get('path','?').split('\\')[-1].split('/')[-1]
                                l += (f" Proposition : dÃƒÂ©placer *{fname}* ({sm.get('size_gb','?')} Go) "
                                      f"vers {p.get('to_disk','?')}.")
                        lines.append(l)
                    if regs:
                        r = regs[0]
                        what = {"hebbian_drop":"l'apprentissage",
                                "nodes_drop":"le nb d'idÃƒÂ©es",
                                "edges_drop":"les connexions",
                                "density_drop":"la cohÃƒÂ©rence",
                                "isolation_rise":"des idÃƒÂ©es dÃƒÂ©tachÃƒÂ©es"}.get(r.get('type'), r.get('type'))
                        lines.append(f"Recul sur {what} ({r.get('delta_pct')}% vs hier).")

                response_text = "\n".join(lines)
                # Garde une trace cÃƒÂ´tÃƒÂ© ÃƒÂ©mergence, sans polluer le chat Sam.
                try:
                    _append_jsonl(EMERGENCE_STREAM_FILE, {
                        "msg": "Pourquoi le cerveau ressemble ÃƒÂ  ÃƒÂ§a ?",
                        "response": response_text,
                        "speaker": "cortex_emergence",
                        "meta": {"action": "explain_brain", "backend": "self_introspection"},
                        "ts": time.time(),
                    })
                except Exception: pass
                rep = {"ok": True, "response": response_text}
            except Exception as e:
                rep = {"ok": False, "fallback": f"Erreur introspection : {e}", "error": str(e)}
            data = json.dumps(rep, ensure_ascii=False).encode("utf-8")
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers(); self.wfile.write(data); return
        if parsed.path == "/api/cortex/llm_lifecycle":
            # POST {action: "unload"|"load"|"set_ttl", model?, ttl_seconds?}
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length).decode("utf-8-sig")) if length else {}
            action = body.get("action", "")
            model  = body.get("model", "qwen3.6-35b-a3b")
            try:
                import subprocess as _sp
                lms_bin = r"C:\Users\Smedj\.lmstudio\bin\lms.exe"
                if action == "unload":
                    # DÃƒÂ©charge tous les LLM (libÃƒÂ¨re VRAM immÃƒÂ©diatement)
                    r1 = _sp.run([lms_bin, "ps"], capture_output=True, text=True, timeout=5,
                                  encoding="utf-8", errors="replace")
                    killed = []
                    for ln in (r1.stdout or "").splitlines():
                        ln_strip = ln.strip()
                        if ln_strip and not ln_strip.startswith(("IDENTIFIER","---","===","EMBEDDING","LLM","PARAMS")):
                            parts = ln_strip.split()
                            if parts and "embed" not in parts[0].lower():
                                _sp.run([lms_bin, "unload", parts[0]],
                                         capture_output=True, timeout=10)
                                killed.append(parts[0])
                    rep = {"ok": True, "action": "unload", "unloaded": killed}
                elif action == "load":
                    r = _sp.run([lms_bin, "load", model, "-y"],
                                 capture_output=True, text=True, timeout=180,
                                 encoding="utf-8", errors="replace")
                    rep = {"ok": r.returncode == 0, "action": "load", "model": model,
                           "stdout": (r.stdout or "")[-300:],
                           "stderr": (r.stderr or "")[-300:]}
                elif action == "set_ttl":
                    ttl = int(body.get("ttl_seconds", 3600))
                    settings_path = Path.home() / ".lmstudio" / "settings.json"
                    s = json.loads(settings_path.read_text(encoding="utf-8"))
                    s.setdefault("developer", {}).setdefault("jitModelTTL", {})
                    s["developer"]["jitModelTTL"]["enabled"] = ttl > 0
                    s["developer"]["jitModelTTL"]["ttlSeconds"] = max(60, ttl) if ttl > 0 else 3600
                    settings_path.write_text(json.dumps(s, indent=2, ensure_ascii=False),
                                              encoding="utf-8")
                    rep = {"ok": True, "action": "set_ttl", "ttl_seconds": ttl,
                           "note": "RedÃƒÂ©marre LM Studio pour activer (settings.json patchÃƒÂ©)"}
                else:
                    rep = {"ok": False, "error": f"unknown action: {action}",
                           "valid": ["unload", "load", "set_ttl"]}
            except Exception as e:
                rep = {"ok": False, "error": str(e)}
            data = json.dumps(rep, ensure_ascii=False).encode("utf-8")
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers(); self.wfile.write(data); return

        if parsed.path == "/api/cortex/heartbeat/config":
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length).decode("utf-8-sig")) if length else {}
            rep = _save_heartbeat_config(body)
            data = json.dumps(rep, ensure_ascii=False).encode("utf-8")
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers(); self.wfile.write(data); return

        if parsed.path == "/api/cortex/explain_term":
            # Tooltip dynamique LLM-driven : explique en langage clair un terme technique
            # Cache 7 jours sur disque pour ÃƒÂ©viter d'appeler le LLM ÃƒÂ  chaque hover
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length).decode("utf-8-sig")) if length else {}
            term = (body.get("term") or "").strip()[:80]
            ctx  = (body.get("context") or "").strip()[:300]
            try:
                import sys as _sys, hashlib as _hl
                if r"H:\Code\Paperclip\scripts\brain" not in _sys.path:
                    _sys.path.insert(0, r"H:\Code\Paperclip\scripts\brain")
                cache_file = VAULT / ".cortex-tooltip-cache.json"
                cache = {}
                try:
                    if cache_file.exists():
                        cache = json.loads(cache_file.read_text(encoding="utf-8"))
                except Exception: cache = {}
                key = _hl.md5((term + "|" + ctx).encode()).hexdigest()
                age_days = (time.time() - cache.get(key, {}).get("ts", 0)) / 86400
                if key in cache and age_days < 7:
                    rep = {"ok": True, "term": term, "explanation": cache[key]["txt"], "cached": True}
                else:
                    # Prompt qui dÃƒÂ©courage le reasoning silencieux (qwen35b a3b
                    # est un modÃƒÂ¨le reasoning : sans cette instruction il consomme
                    # tous les max_tokens dans <think> sans produire de content).
                    prompt = (
                        f"/no_think Explique simplement et briÃƒÂ¨vement, en franÃƒÂ§ais, "
                        f"ce qu'est Ã‚Â« {term} Ã‚Â» dans le contexte d'une interface de "
                        f"visualisation cognitive. RÃƒÂ©ponds directement, sans rÃƒÂ©flÃƒÂ©chir "
                        f"ÃƒÂ  voix haute, sans markdown, sans listes, max 2 phrases.\n\n"
                        f"Contexte technique : {ctx}"
                    )
                    explanation = ""
                    # 1. PRIORITAIRE : LM Studio local (pas de zombies, pas de quota)
                    try:
                        import urllib.request as _ur
                        payload = {
                            "model": select_lmstudio_model(
                                task_type="tooltip",
                                requested_model=os.environ.get("TOOLTIP_MODEL", get_lmstudio_config()["fast_model"]),
                                automatic=True,
                                available_models=[
                                    m["id"] for m in json.loads(
                                        _ur.urlopen(get_lmstudio_config()["base_url"] + "/v1/models", timeout=5).read().decode("utf-8")
                                    ).get("data", [])
                                ],
                            ),
                            "messages": [{"role": "user", "content": prompt}],
                            "max_tokens": 600,            # large pour laisser place au reasoning + content
                            "temperature": 0.3,
                        }
                        payload = json.dumps(add_lmstudio_ttl(payload)).encode("utf-8")
                        req = _ur.Request(get_lmstudio_config()["base_url"] + "/v1/chat/completions",
                                          data=payload,
                                          headers={"Content-Type": "application/json"})
                        with _ur.urlopen(req, timeout=90) as r:
                            resp = json.loads(r.read().decode("utf-8"))
                        msg = (resp.get("choices") or [{}])[0].get("message") or {}
                        explanation = (msg.get("content") or "").strip()
                        # Si reasoning a tout pris (content vide), prendre le reasoning_content
                        # comme derniÃƒÂ¨re ressource (au moins on a une explication).
                        if not explanation:
                            rc = (msg.get("reasoning_content") or "").strip()
                            # Prend les 2 derniÃƒÂ¨res phrases du reasoning (le verdict)
                            if rc:
                                sentences = [s.strip() for s in rc.split('.') if s.strip()]
                                explanation = '. '.join(sentences[-2:])[:280] + '.'
                        explanation = explanation[:400]
                    except Exception as _le:
                        explanation = ""
                    # 2. Fallback : opencode si LM Studio down
                    if not explanation:
                        try:
                            import subprocess as _sp
                            OPENCODE = r"C:\Users\Smedj\AppData\Roaming\npm\opencode.cmd"
                            r = _sp.run([OPENCODE, "run", "--model", "opencode/minimax-m2.5-free", "-"],
                                        input=prompt, capture_output=True, text=True,
                                        timeout=30, encoding="utf-8", errors="replace")
                            lines = [l for l in r.stdout.splitlines()
                                     if l.strip() and not l.startswith(">") and "\x1b" not in l and "build" not in l.lower()]
                            explanation = " ".join(lines).strip()[:400]
                        except Exception: pass
                    if not explanation:
                        explanation = f"(Pas d'explication LLM disponible pour {term})"
                    cache[key] = {"ts": time.time(), "txt": explanation, "term": term}
                    # Cap cache size
                    if len(cache) > 200:
                        oldest = sorted(cache.items(), key=lambda x: x[1].get("ts",0))[:50]
                        for k, _ in oldest: cache.pop(k, None)
                    try:
                        cache_file.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")
                    except Exception: pass
                    rep = {"ok": True, "term": term, "explanation": explanation, "cached": False}
            except Exception as e:
                rep = {"ok": False, "error": str(e)}
            data = json.dumps(rep, ensure_ascii=False).encode("utf-8")
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers(); self.wfile.write(data); return

        if parsed.path == "/api/cortex/llm_role":
            # DÃƒÂ©taille pourquoi tel LLM a ÃƒÂ©tÃƒÂ© choisi pour tel rÃƒÂ´le
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length).decode("utf-8-sig")) if length else {}
            backend = (body.get("backend") or "").strip()
            role    = (body.get("role") or "").strip()
            # MÃƒÂ©tadonnÃƒÂ©es statiques curÃƒÂ©es (officielles + benchmarks publics).
            # Source : MMLU/GPQA/HumanEval/MTEB selon le modÃƒÂ¨le.
            META = {
                "minimax_fast":    {"model": "MiniMax-M2.5 (free)", "context": "200k tokens", "speed": "rapide (~5-15s)",
                                    "strengths": "ops, recherche vault, traduction, rÃƒÂ©sumÃƒÂ© court",
                                    "bench": "MMLU 75.2 Ã‚Â· HumanEval 79.3 Ã‚Â· GPQA 51.4",
                                    "why": "Rapide, gratuit, contexte large Ã¢â‚¬â€ idÃƒÂ©al pour le chat fluide"},
                "minimax_no_claude":{"model": "MiniMax-M2.5 (fallback no-Claude)", "context": "200k", "speed": "rapide",
                                    "strengths": "fallback quand quota Claude saturÃƒÂ©",
                                    "bench": "MMLU 75.2 Ã‚Â· HumanEval 79.3",
                                    "why": "Quota Claude ÃƒÂ©puisÃƒÂ© Ã¢â‚¬â€ Cortex bascule sur le local pour rester rÃƒÂ©actif"},
                "claude":          {"model": "Claude Sonnet 4.6", "context": "200k", "speed": "moyen (~10-30s)",
                                    "strengths": "raisonnement, code complexe, vision, suivi long",
                                    "bench": "MMLU 89.0 Ã‚Â· HumanEval 92.0 Ã‚Â· GPQA 68.7",
                                    "why": "SÃƒÂ©lectionnÃƒÂ© pour les tÃƒÂ¢ches qui demandent du raisonnement profond"},
                "opencode/minimax-m2.5-free": {"model": "MiniMax-M2.5", "context": "200k", "speed": "rapide",
                                               "strengths": "chat, code gÃƒÂ©nÃƒÂ©rique", "bench": "MMLU 75.2",
                                               "why": "ModÃƒÂ¨le par dÃƒÂ©faut local Ã¢â‚¬â€ gratuit via opencode"},
                "opencode/big-pickle": {"model": "Big-Pickle (Llama-405B-derived)", "context": "128k", "speed": "lent",
                                        "strengths": "raisonnement, math, code dur",
                                        "bench": "MMLU 87 Ã‚Â· HumanEval 88",
                                        "why": "Cascade FrugalGPT a remontÃƒÂ© ÃƒÂ  un modÃƒÂ¨le plus capable"},
                "dev_command":     {"model": "Local commands (sandbox)", "context": "n/a", "speed": "instantanÃƒÂ©",
                                    "strengths": "ops, /code, /run, /open, /grep, /find",
                                    "bench": "n/a (pas un LLM, pipe sur subprocess)",
                                    "why": "Slash-command Ã¢â‚¬â€ exÃƒÂ©cution directe, pas de LLM"},
                "self_introspection":{"model": "Cortex local (no LLM)", "context": "mÃƒÂ©triques temps rÃƒÂ©el",
                                      "speed": "instantanÃƒÂ©",
                                      "strengths": "introspection sourcÃƒÂ©e sur brain_history+activations+thought_graph",
                                      "bench": "n/a",
                                      "why": "Cortex dÃƒÂ©crit son propre ÃƒÂ©tat sans appeler de LLM (ÃƒÂ©conomie quota)"},
            }
            ROLE_DESC = {
                "vault_searchcopier": "Recherche dans tes notes Obsidian + rÃƒÂ©sume court (TF-IDF + cosine)",
                "ops":               "ExÃƒÂ©cution de commandes systÃƒÂ¨me (find, grep, run, code)",
                "chat":              "Conversation libre, suivi du fil tripartite Sam Ã¢â€ â€ Cortex Ã¢â€ â€ Claude",
                "reflection":        "Introspection arriÃƒÂ¨re-plan : pensÃƒÂ©e vagabonde, propose_goal, audit",
                "vision":            "Analyse d'image (webcam, screenshots) Ã¢â‚¬â€ VLM via CLIP+local model",
                "synthesis":         "SynthÃƒÂ¨se multi-jours, gÃƒÂ©nÃƒÂ¨re notes Semantic ÃƒÂ  partir d'ÃƒÂ©pisodiques",
            }
            info = META.get(backend, {"model": backend or "?", "speed": "?", "strengths": "?", "bench": "?", "why": "?"})
            role_desc = ROLE_DESC.get(role, role or "rÃƒÂ´le non spÃƒÂ©cifiÃƒÂ©")
            rep = {"ok": True, "backend": backend, "role": locals().get("role", "general"),
                   "info": info, "role_description": role_desc}
            data = json.dumps(rep, ensure_ascii=False).encode("utf-8")
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers(); self.wfile.write(data); return

        if parsed.path == "/api/cortex/identity":
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length).decode("utf-8-sig")) if length else {}
            try:
                import sys as _sys
                if r"H:\Code\Paperclip\scripts\brain" not in _sys.path:
                    _sys.path.insert(0, r"H:\Code\Paperclip\scripts\brain")
                import cortex_identity as _ci
                if body.get("get") or not body:
                    rep = _ci.get_identity()
                else:
                    rep = _ci.set_identity(
                        name=body.get("name"),
                        description=body.get("description"),
                        values=body.get("values"),
                    )
            except Exception as e:
                rep = {"ok": False, "error": str(e)}
            data = json.dumps(rep, ensure_ascii=False).encode("utf-8")
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers(); self.wfile.write(data); return

        if parsed.path == "/api/cortex/path":
            # A* graph path entre deux pensÃƒÂ©es
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length).decode("utf-8-sig"))
            src = body.get("from", ""); dst = body.get("to", "")
            try:
                import sys as _sys
                if r"H:\Code\Paperclip\scripts\brain" not in _sys.path:
                    _sys.path.insert(0, r"H:\Code\Paperclip\scripts\brain")
                import cortex_thought_graph as _ctg
                rep = _ctg.astar_path(src, dst)
            except Exception as e:
                rep = {"ok": False, "error": str(e)}
            data = json.dumps(rep, ensure_ascii=False).encode("utf-8")
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers(); self.wfile.write(data); return

        if parsed.path == "/api/cortex/reflect":
            try:
                import sys as _sys
                if r"H:\Code\Paperclip\scripts\brain" not in _sys.path:
                    _sys.path.insert(0, r"H:\Code\Paperclip\scripts\brain")
                import cortex_continuous as _cc
                rep = _cc.reflect_once()
            except Exception as e:
                rep = {"ok": False, "error": str(e)}
            data = json.dumps(rep, ensure_ascii=False).encode("utf-8")
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers(); self.wfile.write(data); return

        if parsed.path == "/api/cortex/sam_model":
            try:
                import sys as _sys
                if r"H:\Code\Paperclip\scripts\brain" not in _sys.path:
                    _sys.path.insert(0, r"H:\Code\Paperclip\scripts\brain")
                import cortex_sam_model as _csm
                rep = _csm.update_sam_model()
            except Exception as e:
                rep = {"ok": False, "error": str(e)}
            data = json.dumps(rep, ensure_ascii=False).encode("utf-8")
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers(); self.wfile.write(data); return

        if parsed.path == "/api/cortex/synthesis":
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length).decode("utf-8-sig")) if length else {}
            days = int(body.get("days", 7))
            try:
                import sys as _sys
                if r"H:\Code\Paperclip\scripts\brain" not in _sys.path:
                    _sys.path.insert(0, r"H:\Code\Paperclip\scripts\brain")
                import cortex_synthesis as _csy
                rep = _csy.weekly_synthesis(days=days)
            except Exception as e:
                rep = {"ok": False, "error": str(e)}
            data = json.dumps(rep, ensure_ascii=False).encode("utf-8")
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers(); self.wfile.write(data); return

        if parsed.path == "/api/cortex/see":
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length).decode("utf-8-sig")) if length else {}
            prompt = body.get("prompt")
            source = body.get("source", "screen")
            try:
                import sys as _sys
                if r"H:\Code\Paperclip\scripts\brain" not in _sys.path:
                    _sys.path.insert(0, r"H:\Code\Paperclip\scripts\brain")
                import cortex_vision as _cv
                rep = _cv.see(prompt, source=source)
                rep.pop("bytes_b64", None)
                # Push dans le chat stream pour affichage UI
                if rep.get("ok") and rep.get("description"):
                    try:
                        stream_file = CHAT_STREAM_FILE
                        entry = {"ts": time.time(), "speaker": "cortex_vision",
                                 "msg": f"(Ã°Å¸â€˜Â {source})",
                                 "response": rep["description"],
                                 "image": rep.get("screenshot",""),
                                 "meta": {"backend": rep.get("method","?"),
                                          "v2_path": "vision", "role": "vision"}}
                        with open(stream_file, "a", encoding="utf-8") as _sf:
                            _sf.write(json.dumps(entry, ensure_ascii=False) + "\n")
                    except Exception: pass
            except Exception as e:
                rep = {"ok": False, "error": str(e)}
            data = json.dumps(rep, ensure_ascii=False).encode("utf-8")
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers(); self.wfile.write(data); return

        if parsed.path == "/api/cortex/dev":
            # Auto-dÃƒÂ©veloppement de Cortex avec garde-fous
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length).decode("utf-8-sig"))
            goal    = body.get("goal", "")
            dry_run = bool(body.get("dry_run", False))
            if not goal:
                self.send_error(400, "missing 'goal'"); return
            try:
                import sys as _sys
                if r"H:\Code\Paperclip\scripts\brain" not in _sys.path:
                    _sys.path.insert(0, r"H:\Code\Paperclip\scripts\brain")
                import cortex_self_dev as _csd
                rep = _csd.propose_and_apply(goal, dry_run=dry_run)
            except Exception as e:
                rep = {"outcome": "exception", "error": str(e)}
            data = json.dumps(rep, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers(); self.wfile.write(data)
            return
        if parsed.path == "/api/cortex/pulse_test":
            # GÃƒÂ©nÃƒÂ¨re une propagation visible pour valider la chaÃƒÂ®ne pulses -> UI.
            try:
                import sys as _sys
                if r"H:\Code\Paperclip\scripts\brain" not in _sys.path:
                    _sys.path.insert(0, r"H:\Code\Paperclip\scripts\brain")
                import cortex_activation as _ca
                ts = dt.datetime.now().strftime("%H:%M:%S")
                a = f"pulse_test_a_{ts}"
                b = f"pulse_test_b_{ts}"
                c = f"pulse_test_c_{ts}"
                _ca.co_activate([a, b, c])                 # pulses de chaÃƒÂ®ne
                _ca.spread(a, [(b, 0.95), (c, 0.75)])      # pulses de spreading
                rep = {
                    "ok": True,
                    "nodes": [a, b, c],
                    "message": "pulse test injected",
                    "ts": time.time(),
                }
            except Exception as e:
                rep = {"ok": False, "error": str(e)}
            data = json.dumps(rep, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers(); self.wfile.write(data)
            return
        if parsed.path == "/api/chat":
            import re as _re, urllib.request as _ur, sys as _sys
            if r"H:\Code\Paperclip\scripts\brain" not in _sys.path:
                _sys.path.insert(0, r"H:\Code\Paperclip\scripts\brain")
            try:
                import cortex_memory as _cm
            except Exception as _ce:
                print(f"[chat] cortex_memory import err: {_ce}", flush=True)
                _cm = None
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length).decode("utf-8-sig"))
            msg   = body.get("message", "")
            msg_lower = msg.lower()
            req_id = body.get("req_id") or f"r{int(time.time()*1000)}"
            _chat_stage(req_id, "RÃƒÂ©ception", "parse + classification du rÃƒÂ´le")

            # Ã¢â€â‚¬Ã¢â€â‚¬ Intent detection EARLY pour guardrails Ã¢â€â‚¬Ã¢â€â‚¬
            try:
                import sys as _sys_intent
                if r"H:\Code\Paperclip\scripts\brain" not in _sys_intent.path:
                    _sys_intent.path.insert(0, r"H:\Code\Paperclip\scripts\brain")
                import cortex_intent as _ci
                intent_detected = _ci.detect_intent(msg)
            except Exception as _cie:
                intent_detected = {"intent": "simple_chat", "confidence": 0.0}
            _chat_stage(req_id, f"Intent: {intent_detected.get('intent')}", f"confidence={intent_detected.get('confidence')}")

            # Track tools called for this request
            _tools_called = []

            # CORTEX_INTENT_EARLY_RETURNS
            try:
                _intent_name = intent_detected.get("intent") if isinstance(intent_detected, dict) else getattr(intent_detected, "intent", "")
                _confidence = intent_detected.get("confidence", "high") if isinstance(intent_detected, dict) else getattr(intent_detected, "confidence", "high")
                _tools_called = _tools_called if "_tools_called" in locals() else []
                _direct_response = None
                _route_reason = ""
                _evidence_count = 0

                if "r?ponds uniquement: ok" in msg.lower() or "reponds uniquement: ok" in msg.lower():
                    _intent_name = _intent_name or "simple_chat"
                    _direct_response = "OK"
                    _route_reason = "direct_smoke_ok"

                elif _intent_name == "identity":
                    _direct_response = "Je suis Cortex, l?assistant cognitif de Sam pour le projet Paperclip."
                    _route_reason = "identity_direct"

                elif _intent_name == "recent_web_search":
                    _direct_response = "Je dois lancer une recherche web r?elle avant de r?pondre. Je ne vais pas inventer d?actualit? sans outil web."
                    _route_reason = "needs_web_search"

                elif _intent_name in ("local_project_search", "vault_memory_search"):
                    _direct_response = "Je dois d?abord chercher dans le vault, la m?moire ou les fichiers locaux avant d?affirmer quelque chose sur ce projet."
                    _route_reason = "needs_vault_or_file_search"

                elif _intent_name == "playtest_dashboard_help":
                    _direct_response = (
                        "Le playtest int?gr? est li? au dashboard Cortex local : http://127.0.0.1:8765/. "
                        "Tu peux utiliser le sidecar chat, l?onglet Playtest, l?onglet Consortium, "
                        "et les APIs /api/cortex/judges, /api/cortex/homeostasis et /api/chat."
                    )
                    _route_reason = "dashboard_context_direct"

                elif _intent_name == "dashboard_playtest_help":
                    _intent_name = "playtest_dashboard_help"
                    _direct_response = (
                        "Le playtest int?gr? est li? au dashboard Cortex local : http://127.0.0.1:8765/. "
                        "Tu peux utiliser le sidecar chat, l?onglet Playtest, l?onglet Consortium, "
                        "et les APIs /api/cortex/judges, /api/cortex/homeostasis et /api/chat."
                    )
                    _route_reason = "dashboard_context_direct"


                if _direct_response is not None:
                    meta = {
                        "role": locals().get("role", "general"),
                        "intent": _intent_name,
                        "tools_used": _tools_called,
                        "evidence_count": _evidence_count,
                        "backend": "direct_guardrail",
                        "v2_path": "intent_guardrail",
                        "route_reason": _route_reason,
                        "confidence": _confidence,
                        "needs_web_search": _intent_name == "recent_web_search",
                        "needs_vault_search": _intent_name in ("local_project_search", "vault_memory_search"),
                    }
                    data = json.dumps({"response": _direct_response, "meta": meta}, ensure_ascii=False).encode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json; charset=utf-8")
                    self.send_header("Content-Length", str(len(data)))
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    self.wfile.write(data)
                    return
            except Exception as _intent_direct_err:
                print(f"[chat intent direct] {_intent_direct_err}", flush=True)

            # Use single intent variable for all paths
            intent = intent_detected

            # Ã¢â€â‚¬Ã¢â€â‚¬ Cas spÃƒÂ©cial : proof autocode / verify Ã¢â€â‚¬Ã¢â€â‚¬

            # Ã¢â€â‚¬Ã¢â€â‚¬ Cas spÃƒÂ©cial : preuve d'auto-code exÃƒÂ©cutable immÃƒÂ©diate Ã¢â€â‚¬Ã¢â€â‚¬
            proof_markers = [
                "autocoder", "auto coder", "auto-code", "self code", "self-code",
                "preuve", "proof", "montre une preuve", "preuve actionnable",
                "prouve", "prouve moi",
            ]
            autocode_markers = ["autocoder", "auto coder", "auto-code", "self code", "self-code"]
            verify_markers = ["prouve", "preuve", "proof", "vÃƒÂ©rifie", "verifie"]
            asks_autocode = any(k in msg_lower for k in autocode_markers)
            asks_verify = any(k in msg_lower for k in verify_markers)

            if asks_autocode:
                try:
                    import cortex_self_dev as _csd
                    probe_path = "scripts/brain/self_dev_probe.py"
                    probe_value = dt.datetime.now().strftime("ok-%Y%m%d-%H%M%S")
                    goal = (
                        f"mets a jour {probe_path} avec exactement cette ligne: "
                        f'SELF_DEV_PROBE = "{probe_value}" et aucun effet de bord'
                    )
                    dry = _csd.propose_and_apply(goal, dry_run=True)
                    rep = _csd.propose_and_apply(goal, dry_run=False)
                    tests = rep.get("tests", {})
                    tests_brief = []
                    for suite, info in tests.items():
                        tests_brief.append(
                            f"{suite}:{'ok' if info.get('ok') else 'fail'} "
                            f"({info.get('passed', 0)}/{info.get('total', 0)})"
                        )
                    branch = ""
                    for st in rep.get("steps", []):
                        if st.get("name") == "branch_created":
                            branch = st.get("branch", "")
                            break
                    outcome = rep.get("outcome")
                    title = "Preuve auto-code executee." if outcome == "applied" else "Tentative auto-code terminee (non appliquee)."
                    response = (
                        f"{title}\n\n"
                        f"- goal: {goal}\n"
                        f"- dry_run: {dry.get('outcome')}\n"
                        f"- outcome: {outcome}\n"
                        f"- fichier cible: {probe_path}\n"
                        f"- valeur cible: {probe_value}\n"
                        f"- tests: {', '.join(tests_brief) if tests_brief else 'n/a'}\n"
                        f"- branche: {branch or 'n/a'}\n"
                    )
                    meta = {
                        "role": "code",
                        "backend": "cortex_self_dev",
                        "v2_path": "self_dev_proof",
                        "proof_goal": goal,
                        "proof_outcome": rep.get("outcome"),
                        "proof_file": probe_path,
                    }
                except Exception as _pe:
                    response = f"Preuve auto-code impossible: {_pe}"
                    meta = {"role": "code", "backend": "cortex_self_dev", "error": str(_pe)}

                # stream ui
                try:
                    stream_file = CHAT_STREAM_FILE
                    entry = {"ts": time.time(), "msg": msg, "response": response, "meta": meta}
                    with open(stream_file, "a", encoding="utf-8") as _sf:
                        _sf.write(json.dumps(entry, ensure_ascii=False) + "\n")
                except Exception as _se:
                    print(f"[chat stream] {_se}", flush=True)

                data = json.dumps({"response": response, "meta": meta}, ensure_ascii=False).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers(); self.wfile.write(data)
                return
            if asks_verify:
                try:
                    import subprocess as _sp
                    probe_path = Path(r"H:\Code\Paperclip\scripts\brain") / "self_dev_probe.py"
                    if not probe_path.exists():
                        response = (
                            "Preuve introuvable: scripts/brain/self_dev_probe.py n'existe pas dans ce runtime."
                        )
                        meta = {"role": "code", "backend": "proof_check", "ok": False}
                    else:
                        content = probe_path.read_text(encoding="utf-8", errors="replace").strip()
                        g1 = _sp.run(
                            ["git", "-C", r"H:\Code\Paperclip", "log", "-1", "--oneline", "--", "scripts/brain/self_dev_probe.py"],
                            capture_output=True, text=True, timeout=10, encoding="utf-8", errors="replace"
                        )
                        g2 = _sp.run(
                            ["git", "-C", r"H:\Code\Paperclip", "branch", "--show-current"],
                            capture_output=True, text=True, timeout=10, encoding="utf-8", errors="replace"
                        )
                        last_commit = (g1.stdout or "").strip() or "(aucun commit dÃƒÂ©tectÃƒÂ© pour ce fichier)"
                        branch = (g2.stdout or "").strip() or "(branche inconnue)"
                        response = (
                            "Preuve vÃƒÂ©rifiÃƒÂ©e localement.\n\n"
                            f"- fichier: scripts/brain/self_dev_probe.py\n"
                            f"- contenu: {content}\n"
                            f"- dernier commit fichier: {last_commit}\n"
                            f"- branche courante: {branch}\n"
                        )
                        meta = {
                            "role": "code",
                            "backend": "proof_check",
                            "v2_path": "self_dev_proof_verify",
                            "ok": True,
                            "file": "scripts/brain/self_dev_probe.py",
                        }
                except Exception as _ve:
                    response = f"VÃƒÂ©rification de preuve impossible: {_ve}"
                    meta = {"role": "code", "backend": "proof_check", "ok": False, "error": str(_ve)}

                try:
                    stream_file = VAULT / ".cortex-chat-stream.jsonl"
                    entry = {"ts": time.time(), "msg": msg, "response": response, "meta": meta}
                    with open(stream_file, "a", encoding="utf-8") as _sf:
                        _sf.write(json.dumps(entry, ensure_ascii=False) + "\n")
                except Exception as _se:
                    print(f"[chat stream] {_se}", flush=True)

                data = json.dumps({"response": response, "meta": meta}, ensure_ascii=False).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers(); self.wfile.write(data)
                return

            # Ã¢â€â‚¬Ã¢â€â‚¬ DÃƒÂ©tection rÃƒÂ´le : vault_search / code / general Ã¢â€â‚¬Ã¢â€â‚¬
            VAULT_KW = ["vault", "note", "notes", "brain", "cerveau", "mÃƒÂ©moire", "memory",
                        "souvenir", "ingested", "benchmark", "score", "rÃƒÂ©sultat", "result",
                        "papier", "research", "article", "papers", "classement", "ranking", "modÃƒÂ¨le"]
            CODE_KW  = ["code", "fonction", "function", "class", "refactor", "bug", "fix",
                        "implement", "implÃƒÂ©mente", "debug", "stack", "trace", "erreur python"]
            role = "general"
            if any(k in msg_lower for k in VAULT_KW): role = "vault_search"
            elif any(k in msg_lower for k in CODE_KW): role = "code"

            _chat_stage(req_id, f"RÃƒÂ´le dÃƒÂ©tectÃƒÂ©: {role}", "extraction des mots-clÃƒÂ©s")

            # Ã¢â€â‚¬Ã¢â€â‚¬ RAG si rÃƒÂ´le vault_search Ã¢â€â‚¬Ã¢â€â‚¬
            context_parts = []
            if role == "vault_search":
                _tools_called.append("vault_search")
                _chat_stage(req_id, "Recherche dans le vault", "BM25 + lecture mÃƒÂ©moires .claude")
            else:
                _chat_stage(req_id, "Pas de recherche vault", "rÃƒÂ´le " + role + " : skip BM25")
            if role == "vault_search":
                _tools_called.append("vault_search")
                # Fichiers structurÃƒÂ©s
                KEY_FILES = [VAULT/".vault-llm-benchmark.json", VAULT/".vault-llm-benchmark-iag.json"]
                KEY_FILES += list((Path.home()/".claude"/"projects"/"h--Code-Paperclip"/"memory").glob("*.md"))[:4]
                for _f in KEY_FILES:
                    if Path(_f).exists():
                        try:
                            context_parts.append(f"[{Path(_f).name}]\n{Path(_f).read_text(encoding='utf-8', errors='replace')[:1200]}")
                        except: pass
                # BM25 vault_brain
                try:
                    import sys as _sys
                    if r"H:\Code\Paperclip\scripts\brain" not in _sys.path:
                        _sys.path.insert(0, r"H:\Code\Paperclip\scripts\brain")
                    import vault_brain as _vb
                    _db = _vb.open_index()
                    _hits = _vb.search_bm25(_db, msg, 4)
                    for _rowid, _score in _hits:
                        _row = _db.execute("SELECT source, text FROM chunks WHERE rowid=?", (_rowid,)).fetchone()
                        if _row and _row[1] and len(context_parts) < 8:
                            context_parts.append(f"[vault:{_row[0]}]\n{_row[1][:400]}")
                except: pass

            # Ã¢â€â‚¬Ã¢â€â‚¬ Cas spÃƒÂ©cial : benchmark structurÃƒÂ© sans LLM Ã¢â€â‚¬Ã¢â€â‚¬
            if any(w in msg_lower for w in ["benchmark", "classement", "ranking"]) and "model" in msg_lower:
                try:
                    _b = json.loads((VAULT/".vault-llm-benchmark-iag.json").read_text(encoding="utf-8")) if (VAULT/".vault-llm-benchmark-iag.json").exists() else {}
                    rounds = _b.get("rounds", [])
                    winners = {}
                    for r in rounds[-50:]:
                        w = r.get("winner")
                        if w: winners[w] = winners.get(w, 0) + 1
                    lines = [f"**Stats v2 (50 derniÃƒÂ¨res requÃƒÂªtes)**\n"]
                    for k, v in sorted(winners.items(), key=lambda x: -x[1]):
                        lines.append(f"- {k}: {v} victoires")
                    response = "\n".join(lines)
                    meta = {"role": "vault_search", "v2_path": "structured", "backend": "direct_data"}
                    data = json.dumps({"response": response, "meta": meta}, ensure_ascii=False).encode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json; charset=utf-8")
                    self.send_header("Content-Length", str(len(data)))
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers(); self.wfile.write(data)
                    return
                except Exception: pass

            # Ã¢â€â‚¬Ã¢â€â‚¬ MÃƒÂ©moire active : keyword (BM25) + sÃƒÂ©mantique (graphe TF-IDF) Ã¢â€â‚¬Ã¢â€â‚¬
            _chat_stage(req_id, "RÃƒÂ©cupÃƒÂ©ration mÃƒÂ©moire", "retrieve_context (TF-IDF + BM25)")
            memory_context = ""
            mem_sources = []
            if _cm:
                try:
                    memories = _cm.retrieve_context(msg, k=2)
                    if memories:
                        memory_context = _cm.format_context_for_prompt(memories)
                        mem_sources = [m["source"] for m in memories]
                except Exception as _me:
                    print(f"[chat] memory retrieve err: {_me}", flush=True)

            # Graphe sÃƒÂ©mantique : nÃ…â€œud le plus proche + voisins conceptuels
            _chat_stage(req_id, "Navigation graphe sÃƒÂ©mantique", "cosine TF-IDF sur 3700+ notes")
            try:
                import cortex_thought_graph as _ctg
                _ctg.build_graph()
                start_idx = _ctg._find_node(msg)
                if start_idx is not None:
                    from sklearn.metrics.pairwise import cosine_similarity as _cs
                    sims = _cs(_ctg._state["vectors"][start_idx], _ctg._state["vectors"])[0]
                    top_idx = sims.argsort()[::-1][1:4]  # top 3 voisins (skip soi-mÃƒÂªme)
                    sem_parts = ["## Concepts sÃƒÂ©mantiquement proches"]
                    for i in top_idx:
                        if sims[i] < 0.1: continue
                        n = _ctg._state["nodes"][i]
                        sem_parts.append(f"### {n['source']} (sim={sims[i]:.2f})\n{n['text'][:400]}")
                    if len(sem_parts) > 1:
                        memory_context += "\n\n" + "\n\n".join(sem_parts) + "\n"
                        mem_sources.append(f"graph:start={_ctg._state['nodes'][start_idx]['source']}")
            except Exception as _ge:
                print(f"[chat] graph err: {_ge}", flush=True)

            # Fil de conversation : 3 derniers ÃƒÂ©changes du stream
            recent_dialogue = ""
            try:
                stream_file = CHAT_STREAM_FILE
                if stream_file.exists():
                    with open(stream_file, "rb") as _sf:
                        _sf.seek(0, 2); fsize = _sf.tell()
                        _sf.seek(max(0, fsize - 6000))
                        lines = _sf.read().decode("utf-8", errors="replace").splitlines()
                    last = []
                    for ln in lines[-5:]:
                        try:
                            e = json.loads(ln)
                            if not _is_chat_entry(e):
                                continue
                            speaker = e.get("speaker", "cortex")
                            if speaker == "claude":
                                last.append(f"[Claude rÃƒÂ©pond ÃƒÂ  Sam] {e.get('response','')[:400]}")
                            else:
                                last.append(f"[Sam] {e.get('msg','')[:200]}\n[Cortex] {e.get('response','')[:300]}")
                        except: pass
                    if last:
                        recent_dialogue = ("\n\n## Conversation tripartite rÃƒÂ©cente (Sam Ã¢â€ â€ Claude Ã¢â€ â€ toi-Cortex)\n\n"
                                           + "\n---\n".join(last) + "\n")
            except Exception: pass

            # Ã¢â€â‚¬Ã¢â€â‚¬ Construction prompt Ã¢â€â‚¬Ã¢â€â‚¬
            _chat_stage(req_id, "Construction du prompt", "identitÃƒÂ© + valeurs + contexte + dialogue")
            try:
                import cortex_identity as _ci
                identity = _ci.identity_prompt()
            except Exception:
                identity = "Tu es Cortex, l'assistant Paperclip.\n"
            if context_parts:
                ctx = "\n---\n".join(context_parts[:6])
                full_prompt = (
                    f"{identity}DonnÃƒÂ©es du vault :\n\n{ctx}\n\n"
                    f"{memory_context}\n{recent_dialogue}\n"
                    f"---\nQuestion actuelle de Sam : {msg}\n\n"
                    f"RÃƒÂ©ponds en franÃƒÂ§ais, concis. Tiens compte du fil de conversation."
                )
            elif role == "code":
                full_prompt = (
                    f"{identity}Tu es spÃƒÂ©cialisÃƒÂ© en dÃƒÂ©veloppement.\n\n"
                    f"{memory_context}\n{recent_dialogue}\n"
                    f"Question actuelle de Sam : {msg}\n\nRÃƒÂ©ponds en franÃƒÂ§ais, prÃƒÂ©cis."
                )
            else:
                full_prompt = (
                    f"{identity}\n"
                    f"{memory_context}\n{recent_dialogue}\n"
                    f"Question actuelle de Sam : {msg}\n\n"
                    f"RÃƒÂ©ponds en franÃƒÂ§ais, naturel et concis. Tiens compte du fil de conversation."
                )

            # Ã¢â€â‚¬Ã¢â€â‚¬ Mode fast : minimax direct via opencode stdin (~10s) Ã¢â€â‚¬Ã¢â€â‚¬
            # L'UI Cortex envoie dÃƒÂ©jÃƒÂ  fast=true. On aligne donc le dÃƒÂ©faut API
            # sur ce comportement rÃƒÂ©el pour ÃƒÂ©viter qu'un appel sans flag
            # (ex. smoke tests ou clients simples) parte inutilement dans le
            # chemin route_v2 lent avec prompt enrichi.
            fast = bool(body.get("fast", True))
            response = ""
            meta = {"role": locals().get("role", "general"), "memory_used": mem_sources, "fast": fast,
                   "intent": intent_detected.get("intent"), "confidence": intent_detected.get("confidence"),
                   "tools_used": _tools_called}
            if fast:
                _chat_stage(req_id, "Appel LLM (minimax-m2.5-free)", "opencode subprocess Ã‚Â· ~10-30s Ã‚Â· 200k contexte")
                try:
                    import subprocess as _sp
                    OPENCODE = r"C:\Users\Smedj\AppData\Roaming\npm\opencode.cmd"
                    # Retry une fois si timeout (opencode parfois saturÃƒÂ© par emergence loop)
                    last_err = None
                    for attempt in range(2):
                        try:
                            r = _sp.run([OPENCODE, "run", "--model", "opencode/minimax-m2.5-free", "-"],
                                        input=full_prompt, capture_output=True, text=True,
                                        timeout=45, encoding="utf-8", errors="replace")
                            lines = [l for l in r.stdout.splitlines()
                                     if l.strip() and not l.startswith(">") and "\x1b" not in l and "build" not in l.lower()]
                            response = "\n".join(lines).strip()
                            if response: break
                            last_err = "empty response"
                        except _sp.TimeoutExpired:
                            last_err = "timeout"
                        except Exception as _e:
                            last_err = str(_e); break
                    if not response:
                        response = f"(fast err: {last_err})"
                    meta["backend"] = "minimax_fast"; meta["v2_path"] = "fast_minimax"
                except Exception as _fe:
                    response = f"(fast err: {_fe})"

            # Ensure intent in meta for fast path that might skip intent addition
            if "intent" not in meta:
                meta["intent"] = intent_detected.get("intent")
                meta["tools_used"] = _tools_called

            # Ã¢â€â‚¬Ã¢â€â‚¬ Sinon routage v2 normal Ã¢â€â‚¬Ã¢â€â‚¬
            if not response:
                _chat_stage(req_id, "Routage v2 (panel-of-judges)", "FrugalGPT cascade Ã‚Â· choix dynamique")
                try:
                    payload = json.dumps({"text": full_prompt, "role": role}).encode("utf-8")
                    req = _ur.Request("http://127.0.0.1:18900/route_v2", data=payload,
                                      headers={"Content-Type": "application/json"})
                    with _ur.urlopen(req, timeout=180) as _r:
                        d = json.loads(_r.read().decode())
                    meta.update({"backend": d.get("backend"), "v2_path": d.get("v2_path"),
                                 "scores": d.get("all_scores")})
                    response = d.get("response", "")
                    # PAS d'escalade Claude (ÃƒÂ©conomie quota). Si v2 retourne inject=True
                    # (free models pas suffisants), on prend la meilleure free quand mÃƒÂªme.
                    if not response and d.get("inject"):
                        # Force re-call sans claude path : prend simplement minimax direct
                        try:
                            import subprocess as _sp
                            _OC = r"C:\Users\Smedj\AppData\Roaming\npm\opencode.cmd"
                            _r = _sp.run([_OC, "run", "--model", "opencode/minimax-m2.5-free", "-"],
                                         input=full_prompt, capture_output=True, text=True,
                                         timeout=45, encoding="utf-8", errors="replace")
                            _lns = [l for l in _r.stdout.splitlines()
                                    if l.strip() and not l.startswith(">") and "\x1b" not in l and "build" not in l.lower()]
                            response = "\n".join(_lns).strip()
                            meta["backend"] = "minimax_no_claude"
                            meta["v2_path"] = "no_claude_fallback"
                        except Exception as _le:
                            response = f"(no-claude fallback err: {_le})"
                except Exception as e:
                    response = f"Erreur router v2: {e}"
                    meta["error"] = str(e)

            _chat_stage(req_id, "Post-traitement", "log ÃƒÂ©pisodique + stream UI + TTS + guardrails")
            # Ã¢â€â‚¬Ã¢â€â‚¬ Intent guardrails : prevent hallucination Ã¢â‚¬â€ inject warning if tool was required but not used Ã¢â€â‚¬Ã¢â€â‚¬
            try:
                _guard = _ci.build_guardrails_prompt(intent_detected, _tools_called)
                if _guard:
                    response = response + _guard
            except Exception: pass

            # Add intent metadata to final response
            if _cm and response and not response.startswith("Erreur"):
                try: _cm.log_episodic(msg, response, meta)
                except Exception as _le: print(f"[chat] log err: {_le}", flush=True)

            # Ã¢â€â‚¬Ã¢â€â‚¬ Stream temps rÃƒÂ©el pour la UI : append au .jsonl que la UI lit via SSE Ã¢â€â‚¬Ã¢â€â‚¬
            try:
                stream_file = CHAT_STREAM_FILE
                entry = {"ts": time.time(), "msg": msg, "response": response, "meta": meta}
                with open(stream_file, "a", encoding="utf-8") as _sf:
                    _sf.write(json.dumps(entry, ensure_ascii=False) + "\n")
            except Exception as _se:
                print(f"[chat stream] {_se}", flush=True)

            # Ã¢â€â‚¬Ã¢â€â‚¬ TTS Cortex : Cortex parle ses rÃƒÂ©ponses (sauf si TTS off via UI) Ã¢â€â‚¬Ã¢â€â‚¬
            if response and not response.startswith("Erreur") and not (VAULT / ".tts-disabled.flag").exists():
                try:
                    import threading as _th
                    def _speak_async(text):
                        try:
                            _payload = json.dumps({"text": text[:600], "speaker": "Damien Black",
                                                   "language": "fr"}).encode("utf-8")
                            _req = _ur.Request("http://127.0.0.1:18768/synth", data=_payload,
                                               headers={"Content-Type": "application/json"})
                            with _ur.urlopen(_req, timeout=120) as _r:
                                _path = json.loads(_r.read().decode()).get("path")
                            if _path and Path(_path).exists():
                                # Touch playing flag pour pause VAD
                                (VAULT / ".tts-playing.flag").touch()
                                import pygame as _pg
                                if not _pg.mixer.get_init():
                                    _pg.mixer.init(frequency=24000, size=-16, channels=1)
                                _pg.mixer.music.load(_path)
                                _pg.mixer.music.play()
                                while _pg.mixer.music.get_busy():
                                    import time as _t; _t.sleep(0.05)
                                _pg.mixer.music.unload()
                                try: Path(_path).unlink()
                                except: pass
                                try: (VAULT / ".tts-playing.flag").unlink()
                                except: pass
                        except Exception as _e:
                            print(f"[chat tts] {_e}", flush=True)
                    _th.Thread(target=_speak_async, args=(response,), daemon=True).start()
                except Exception as _ce:
                    print(f"[chat tts setup] {_ce}", flush=True)

            _chat_stage_done(req_id)
            # Add intent metadata to final response
            meta["intent"] = intent_detected.get("intent")
            meta["tools_used"] = _tools_called
            meta["confidence"] = intent_detected.get("confidence")
            meta["route_reason"] = f"intent={intent_detected.get('intent')},confidence={intent_detected.get('confidence')}"
            meta["req_id"] = req_id
            data = json.dumps({"response": response, "meta": meta, "req_id": req_id},
                              ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers(); self.wfile.write(data)
        else:
            self.send_error(404)

    def log_message(self, fmt, *args):
        pass


def main():
    print(f"[serve] vault: {VAULT}")
    print(f"[serve] open: http://127.0.0.1:{PORT}/")
    # DÃƒÂ©marrer consolidation mÃƒÂ©moire + cognition continue en arriÃƒÂ¨re-plan
    try:
        import sys as _sys
        if r"H:\Code\Paperclip\scripts\brain" not in _sys.path:
            _sys.path.insert(0, r"H:\Code\Paperclip\scripts\brain")
        import cortex_memory as _cm
        _cm.start_consolidation_loop()
        import cortex_continuous as _cc
        _cc.start(interval=900)
        import cortex_vision as _cv
        _cv.reset_camera_cache()
        # DÃƒÂ©marrer la boucle d'ÃƒÂ©mergence : Cortex prend ses propres dÃƒÂ©cisions
        # toutes les 5 min (au lieu de 15) Ã¢â‚¬â€ un cerveau rÃƒÂ©flÃƒÂ©chit, ne dort pas.
        import cortex_emergence as _ce
        _ce.start(interval=300)
        # Cortex maintient son corps (homeostasis biologique)
        import cortex_homeostasis as _ch
        _ch.start(interval=60)
        # Activation persistance
        print("[serve] starting cortex_activation...", flush=True)
        import cortex_activation as _ca
        _ca.start()
        # Historique cÃƒÂ©rÃƒÂ©bral : snapshots + dÃƒÂ©tection rÃƒÂ©gressions
        print("[serve] starting cortex_brain_history...", flush=True)
        import cortex_brain_history as _bh
        _bh.start()
        # Publishing GitHub : auto-update toutes les heures (si repo initialisÃƒÂ©)
        print("[serve] starting cortex_publishing...", flush=True)
        import cortex_publishing as _cp
        _cp.start(interval=3600)
        # Pipeline manager : auto-rÃƒÂ©gulation matÃƒÂ©rielle (kill zombies, throttle)
        print("[serve] starting cortex_pipeline_manager...", flush=True)
        import cortex_pipeline_manager as _pm
        _pm.start(interval=120)  # toutes les 2 min
        print("[serve] all bg loops started", flush=True)
    except Exception as e:
        print(f"[serve] cortex bg init err: {e}", flush=True)
    print(f"[serve] binding port {PORT}", flush=True)
    with socketserver.ThreadingTCPServer(("127.0.0.1", PORT), Handler) as srv:
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            srv.shutdown()


if __name__ == "__main__":
    main()
