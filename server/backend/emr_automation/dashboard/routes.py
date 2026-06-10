"""
Dashboard API routes and page handlers.

Provides REST API for the EMR Dashboard including:
- System status and patient info
- Prescription/discharge workflow actions
- Comprehensive pediatric dosage calculator
- Audit log access and export
- Configuration management
- Real-time Server-Sent Events
"""

import configparser
import io
import json
import logging
import math
import os
import queue
import tempfile
import threading
import time
from datetime import datetime, timedelta, timezone
import importlib.util
from pathlib import Path
from typing import Optional

from flask import (
    Blueprint,
    Response,
    current_app,
    g,
    jsonify,
    render_template,
    request,
    send_file,
    stream_with_context,
)

from emr_automation.audit_log import get_audit_logger
from keychain_helper import keychain_secret

from emr_automation.auth import optional_auth, require_auth, require_extension_or_user, require_sse_auth, mint_sse_cookie
from emr_automation.auth import _authorized_parties
from emr_automation.billing import (
    check_usage_limit,
    log_usage,
    create_checkout_session,
    create_portal_session,
    handle_webhook,
    get_subscription,
)
from emr_automation.constants import DEFAULT_CONFIG, DEFAULT_RX_TEMPLATES, PrescriptionTemplate
from emr_automation.models import UserConfig
from emr_automation.openai_auth import build_openai_client, has_openai_oauth_config

bp = Blueprint("dashboard", __name__)
logger = logging.getLogger(__name__)

# Hard safety caps to avoid accidentally returning/exporting huge payloads.
MAX_AUDIT_LIMIT = 500
MAX_AUDIT_EXPORT_DAYS = 365

# Protect config.ini writes from concurrent requests.
_config_write_lock = threading.Lock()

_rate_limit_lock = threading.Lock()
_rate_limit_hits: dict[str, list[float]] = {}
_RATE_LIMIT_MAX = int(os.environ.get("TOCAFICHADR_RATE_LIMIT_MAX", "30"))
_RATE_LIMIT_WINDOW_SECONDS = int(os.environ.get("TOCAFICHADR_RATE_LIMIT_WINDOW_SECONDS", "60"))
_MAX_AUDIO_BYTES = int(os.environ.get("TOCAFICHADR_MAX_AUDIO_BYTES", str(20 * 1024 * 1024)))

# ══════════════════════════════════════════════════════════════════
# Audio Recorder State
# ══════════════════════════════════════════════════════════════════

def _project_root() -> Path:
    """Return project root directory (`.../Pediatrics`)."""
    return Path(__file__).resolve().parent.parent.parent


def _trusted_proxy_addrs() -> set[str]:
    raw = os.environ.get("TOCAFICHADR_TRUSTED_PROXY_IPS", "127.0.0.1,::1")
    return {item.strip() for item in raw.split(",") if item.strip()}


def _client_ip() -> str:
    remote_addr = request.remote_addr or ""
    if remote_addr in _trusted_proxy_addrs():
        cf_ip = request.headers.get("CF-Connecting-IP", "").strip()
        if cf_ip:
            return cf_ip
        xff = request.headers.get("X-Forwarded-For", "").split(",", 1)[0].strip()
        if xff:
            return xff
    return remote_addr or "unknown"


def _rate_limit_key() -> str:
    if getattr(g, "user_id", None) is not None:
        return f"user:{g.user_id}"
    return f"ip:{_client_ip()}"


def _rate_limit_response():
    now = time.time()
    window_start = now - _RATE_LIMIT_WINDOW_SECONDS
    key = _rate_limit_key()
    with _rate_limit_lock:
        hits = [ts for ts in _rate_limit_hits.get(key, []) if ts >= window_start]
        if len(hits) >= _RATE_LIMIT_MAX:
            _rate_limit_hits[key] = hits
            return jsonify({
                "error": "Muitas solicitações. Aguarde alguns instantes e tente novamente.",
                "code": "RATE_LIMIT",
            }), 429
        hits.append(now)
        _rate_limit_hits[key] = hits
    return None


def _billable_request_guard():
    limited = _rate_limit_response()
    if limited is not None:
        return limited
    if getattr(g, "user_id", None) is not None and not check_usage_limit(g.user_id):
        return jsonify({
            "error": "Daily limit reached. Upgrade to Pro for unlimited usage.",
            "code": "USAGE_LIMIT",
        }), 429
    return None


def _log_billable_usage(action: str) -> None:
    if getattr(g, "user_id", None) is None:
        return
    try:
        log_usage(g.user_id, action)
    except Exception:
        logger.exception("usage logging failed for action=%s user_id=%s", action, g.user_id)


def _is_billable_success(result) -> bool:
    """A request is billable only if the underlying operation actually succeeded.

    The extension_api functions (transcribe_audio / format_soap / suggest_cid /
    format_atestado_letter) catch their own errors and RETURN an error dict or a
    non-2xx ``status_code`` instead of raising. So an UNCONDITIONAL
    _log_billable_usage() charged a free-tier doctor one of their FREE_DAILY_LIMIT
    daily uses for a *failed* transcription / SOAP / CID / atestado (an OpenAI
    timeout, a "audio too small" 400, etc.). Bill only on success.

    Fails open for unexpected shapes so we never silently stop counting
    legitimate usage.
    """
    if not isinstance(result, dict):
        return True
    if result.get("error"):
        return False
    sc = result.get("status_code")
    if isinstance(sc, int) and not (200 <= sc < 300):
        return False
    return True


def _resolve_audio_script_path() -> Path:
    """
    Resolve `audio_to_note.py` from config/env, with stable fallback paths.
    """
    root = _project_root()
    fallback = root.parent / "Whisper Scripts" / "scripts" / "audio_to_note.py"
    candidates: list[Path] = []

    emr = current_app.config.get("EMR_INSTANCE")
    emr_script = getattr(emr, "audio_to_note_script", None) if emr else None
    if emr_script:
        candidates.append(Path(emr_script).expanduser())

    config = current_app.config.get("CONFIG_PARSER") or configparser.ConfigParser()
    config_path = current_app.config.get("CONFIG_PATH")
    if config_path and Path(config_path).exists():
        config.read(config_path)
    configured = config.get("ExternalScripts", "audio_to_note_script", fallback="").strip()
    if configured:
        configured_path = Path(configured).expanduser()
        if not configured_path.is_absolute():
            configured_path = (root / configured_path).resolve()
        candidates.append(configured_path)

    env_path = os.getenv("AUDIO_TO_NOTE_SCRIPT", "").strip()
    if env_path:
        env_candidate = Path(env_path).expanduser()
        if not env_candidate.is_absolute():
            env_candidate = (root / env_candidate).resolve()
        candidates.append(env_candidate)

    candidates.extend([
        fallback,
        root / "Whisper Scripts" / "scripts" / "audio_to_note.py",
    ])

    for candidate in candidates:
        if candidate.exists():
            return candidate.resolve()
    return fallback.resolve()


def _load_audio_module(script_path: Path):
    """Dynamically import `audio_to_note.py` from a file path."""
    spec = importlib.util.spec_from_file_location("audio_to_note", script_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load audio module from {script_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class AudioRecorder:
    """Manages audio recording state and background thread."""

    def __init__(self):
        self.is_recording = False
        self.stop_event = threading.Event()
        self.thread: Optional[threading.Thread] = None
        self.temp_file: Optional[Path] = None
        self.error: Optional[str] = None
        self.transcription: Optional[str] = None
        self.soap_note: Optional[str] = None
        self._lock = threading.Lock()

    def start(self) -> dict:
        with self._lock:
            if self.is_recording:
                return {"status": "already_recording"}

            script_path = _resolve_audio_script_path()
            if not script_path.exists():
                self.error = f"Audio script not found at {script_path}"
                return {"error": self.error}

            self.stop_event.clear()
            self.error = None
            self.transcription = None
            self.soap_note = None
            self.is_recording = True

            temp_audio = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
            temp_audio.close()
            self.temp_file = Path(temp_audio.name)

        def _record():
            try:
                module = _load_audio_module(script_path)
                module.record_audio(self.temp_file, self.stop_event)
            except Exception as exc:
                with self._lock:
                    self.error = str(exc)
            finally:
                with self._lock:
                    self.is_recording = False

        with self._lock:
            self.thread = threading.Thread(target=_record, daemon=True)
            self.thread.start()
        return {"status": "started"}

    def stop(self) -> dict:
        with self._lock:
            if not self.is_recording and not self.temp_file:
                return {"error": "Not recording"}
            self.stop_event.set()
            thread = self.thread
            temp_file = self.temp_file
            script_path = _resolve_audio_script_path()

        if thread:
            thread.join(timeout=5.0)

        with self._lock:
            if self.error:
                return {"error": self.error}

        if not script_path.exists():
            return {"error": f"Audio script not found at {script_path}"}
        if not temp_file or not temp_file.exists():
            return {"error": "No audio file created"}

        try:
            module = _load_audio_module(script_path)

            config = current_app.config.get("CONFIG_PARSER") or configparser.ConfigParser()
            config_path = current_app.config.get("CONFIG_PATH")
            if config_path and Path(config_path).exists():
                config.read(config_path)

            client = build_openai_client(config)
            if client is None:
                return {"error": "OpenAI OAuth not configured"}

            transcript = module.transcribe_audio(client, temp_file)
            soap_note, _ = module.summarise_to_soap(client, transcript)

            with self._lock:
                self.transcription = transcript
                self.soap_note = soap_note
                self.error = None
            return {
                "transcript": transcript,
                "soap_note": soap_note,
            }
        except Exception as exc:
            with self._lock:
                self.error = f"Processing failed: {str(exc)}"
            return {"error": f"Processing failed: {str(exc)}"}
        finally:
            try:
                if temp_file and temp_file.exists():
                    temp_file.unlink()
            except Exception:
                pass
            with self._lock:
                self.temp_file = None
                self.thread = None

    def status(self) -> dict:
        script_path = _resolve_audio_script_path()
        with self._lock:
            return {
                "recording": self.is_recording,
                "error": self.error,
                "has_transcript": bool(self.transcription),
                "has_soap_note": bool(self.soap_note),
                "script_path": str(script_path),
                "script_exists": script_path.exists(),
            }


# Global recorder instance
recorder = AudioRecorder()


# ══════════════════════════════════════════════════════════════════
# Pediatric Medication Database
# ══════════════════════════════════════════════════════════════════

PEDIATRIC_MEDICATIONS = [
    # ── Antibiotics ──────────────────────────────────────────────
    {
        "id": "amox_strep",
        "name": "Amoxicilina (Faringite)",
        "category": "antibiotics",
        "dose_per_kg": 50,
        "max_daily": 1000,
        "times_per_day": 2,
        "frequency": "12/12h",
        "duration": "7 dias",
        "concentration": 50,
        "presentation": "250mg/5mL",
        "notes": "Faringite estreptocócica",
    },
    {
        "id": "amox_pneum",
        "name": "Amoxicilina (Pneumonia/OMA)",
        "category": "antibiotics",
        "dose_per_kg": 90,
        "max_daily": 4000,
        "times_per_day": 2,
        "frequency": "12/12h",
        "duration": "7-10 dias",
        "concentration": 50,
        "presentation": "250mg/5mL",
        "notes": "Pneumonia, OMA, sinusite",
    },
    {
        "id": "amox_clav",
        "name": "Amoxi + Clavulanato",
        "category": "antibiotics",
        "dose_per_kg": 50,
        "max_daily": 3000,
        "times_per_day": 2,
        "frequency": "12/12h",
        "duration": "7-10 dias",
        "concentration": 80,
        "presentation": "400mg/5mL (BD)",
        "notes": "OMA refratária, sinusite, mordeduras",
    },
    {
        "id": "cephalexin",
        "name": "Cefalexina",
        "category": "antibiotics",
        "dose_per_kg": 50,
        "max_daily": 2000,
        "times_per_day": 3,
        "frequency": "8/8h",
        "duration": "7 dias",
        "concentration": 50,
        "presentation": "250mg/5mL",
        "notes": "ITU, infecções de pele",
    },
    {
        "id": "azithromycin",
        "name": "Azitromicina",
        "category": "antibiotics",
        "dose_per_kg": 10,
        "max_daily": 500,
        "times_per_day": 1,
        "frequency": "1x/dia",
        "duration": "5 dias (D1: 10mg/kg, D2-5: 5mg/kg)",
        "concentration": 40,
        "presentation": "200mg/5mL",
        "notes": "Coqueluche, pneumonia atípica",
    },
    # ── Analgesics / Antipyretics ────────────────────────────────
    {
        "id": "ibuprofen",
        "name": "Ibuprofeno",
        "category": "analgesics",
        "dose_per_kg": 30,
        "max_daily": 1200,
        "times_per_day": 3,
        "frequency": "8/8h",
        "duration": "SN",
        "concentration": 50,
        "presentation": "Gotas 50mg/mL",
        "drops_per_ml": 20,
        "notes": "Febre, dor. >6 meses. Evitar se desidratação.",
    },
    {
        "id": "dipyrone",
        "name": "Dipirona",
        "category": "analgesics",
        "dose_per_kg": 60,
        "max_daily": 4000,
        "times_per_day": 4,
        "frequency": "6/6h",
        "duration": "SN",
        "concentration": 500,
        "presentation": "Gotas 500mg/mL",
        "drops_per_ml": 20,
        "practical_rule": "1 gota/kg",
        "notes": "Febre, dor. Regra prática: 1 gota/kg.",
    },
    {
        "id": "paracetamol",
        "name": "Paracetamol",
        "category": "analgesics",
        "dose_per_kg": 60,
        "max_daily": 3000,
        "times_per_day": 4,
        "frequency": "6/6h",
        "duration": "SN",
        "concentration": 200,
        "presentation": "Gotas 200mg/mL",
        "drops_per_ml": 20,
        "practical_rule": "1 gota/kg",
        "notes": "Febre, dor. Regra prática: 1 gota/kg.",
    },
    # ── Corticosteroids ──────────────────────────────────────────
    {
        "id": "prednisolone",
        "name": "Prednisolona",
        "category": "corticoids",
        "dose_per_kg": 1,
        "max_daily": 60,
        "times_per_day": 1,
        "frequency": "1x/dia",
        "duration": "3-5 dias",
        "concentration": 3,
        "presentation": "Sol. oral 3mg/mL",
        "notes": "Asma, crupe, laringite. Pode dividir em 2x/dia.",
    },
    # ── Antihistamines ───────────────────────────────────────────
    # ── Other ────────────────────────────────────────────────────
    {
        "id": "salbutamol_neb",
        "name": "Salbutamol (Nebulização)",
        "category": "others",
        "dose_per_kg": 0.15,
        "max_daily": 5,
        "times_per_day": 1,
        "frequency": "20/20min (crise) ou 4/4h",
        "duration": "Conforme evolução",
        "concentration": 5,
        "presentation": "Sol. 5mg/mL + 3mL SF",
        "min_dose": 2.5,
        "notes": "Mín 0,5mL (2,5mg). Diluir em 3mL SF 0,9%.",
    },
    # ── SUS Common Antibiotics ───────────────────────────────────
    {
        "id": "sulfa_tmp",
        "name": "Sulfametoxazol+Trimetoprima (Bactrim)",
        "category": "antibiotics",
        "dose_per_kg": 6,
        "max_daily": 320,
        "times_per_day": 2,
        "frequency": "12/12h",
        "duration": "5-10 dias",
        "concentration": 8,
        "presentation": "Susp. 200/40mg/5mL",
        "notes": "ITU, OMA, pneumocistose. Atenção: alergia a sulfa.",
        "provenance": "SUS/Ministério da Saúde",
    },
    {
        "id": "penicillin_v",
        "name": "Fenoximetilpenicilina (Penicilina V)",
        "category": "antibiotics",
        "dose_per_kg": 25,
        "max_daily": 3000,
        "times_per_day": 2,
        "frequency": "12/12h",
        "duration": "10 dias",
        "concentration": 50,
        "presentation": "Susp. 250mg/5mL",
        "notes": "Faringite estreptocócica. Alternativa à amoxicilina.",
        "provenance": "SUS/Ministério da Saúde",
    },
    {
        "id": "benzetacil",
        "name": "Penicilina G Benzatínica (Benzetacil)",
        "category": "antibiotics",
        "times_per_day": 1,
        "frequency": "Dose única IM",
        "duration": "1 dose",
        "presentation": "Inj. 600.000 UI (1-4a) / 1.200.000 UI (>4a)",
        "notes": "Faringite estreptocócica. Profilaxia de febre reumática.",
        "dose_unit": "UI",
        "weight_based_doses": [
            {"min_kg": 0, "max_kg": 27, "dose_mg": 600000},
            {"min_kg": 27, "max_kg": 999, "dose_mg": 1200000},
        ],
        "provenance": "SUS/Ministério da Saúde",
    },
    # ── SUS Antiparasitics ──────────────────────────────────────
    {
        "id": "albendazole",
        "name": "Albendazol",
        "category": "antiparasitics",
        "times_per_day": 1,
        "frequency": "Dose única",
        "duration": "Repetir em 15 dias",
        "presentation": "Susp. 400mg/10mL ou Comp. 400mg",
        "notes": "Ancilostomíase, ascaridíase. >2 anos: 400mg; <2 anos: 200mg.",
        "weight_based_doses": [
            {"min_kg": 0, "max_kg": 12, "dose_mg": 200},
            {"min_kg": 12, "max_kg": 999, "dose_mg": 400},
        ],
        "provenance": "SUS/Ministério da Saúde",
    },
    {
        "id": "metronidazole",
        "name": "Metronidazol",
        "category": "antiparasitics",
        "dose_per_kg": 15,
        "max_daily": 2000,
        "times_per_day": 3,
        "frequency": "8/8h",
        "duration": "5-7 dias",
        "concentration": 50,
        "presentation": "Susp. 250mg/5mL",
        "notes": "Giardíase, amebíase. >1 ano.",
        "provenance": "SUS/Ministério da Saúde",
    },
    # ── SUS Antifungals ─────────────────────────────────────────
    # ── SUS Antihistamines ──────────────────────────────────────
    {
        "id": "promethazine",
        "name": "Prometazina (Fenergan)",
        "category": "antihistamines",
        "dose_per_kg": 0.5,
        "max_daily": 25,
        "times_per_day": 3,
        "frequency": "8/8h",
        "duration": "SN",
        "concentration": 2,
        "presentation": "Xarope 2mg/mL",
        "notes": "Rinite, urticária, náusea. >2 anos. Cuidado: sedação.",
        "provenance": "SUS/Ministério da Saúde",
    },
    # ── SUS Supplements ─────────────────────────────────────────
    {
        "id": "vitamin_d",
        "name": "Vitamina D",
        "category": "supplements",
        "times_per_day": 1,
        "frequency": "1x/dia",
        "duration": "Contínuo",
        "presentation": "Gotas 200 UI/gota",
        "notes": "Suplementação. 400-1000 UI/dia conforme idade.",
        "dose_unit": "UI",
        "weight_based_doses": [
            {"min_kg": 0, "max_kg": 12, "dose_mg": 400},
            {"min_kg": 12, "max_kg": 999, "dose_mg": 600},
        ],
        "provenance": "SUS/Ministério da Saúde",
    },
    # ════════════════════════════════════════════════════════════════
    # CHRA-2048 — popup-parity additions (batch 2/2). Mirror of the
    # popup _MED_CATALOG_FALLBACK pediatric set (CHRA-2044). These 15
    # substances exist in the popup catalog but were missing from the
    # online backend. Every dose value below is traced to the popup
    # `notes` (RENAME 2024) and cross-checked against conduta-rapida
    # src/data/drugs.ts. Additive only — entries above are unchanged.
    # Medical dosing -> Reviewer clinical gate.
    # ── Antibiotics (parity) ─────────────────────────────────────
    {
        "id": "claritro_ped",
        "name": "Claritromicina",
        "category": "antibiotics",
        "dose_per_kg": 15,          # 7,5 mg/kg/dose x 2 (12/12h)
        "max_daily": 1000,          # 500 mg/dose x 2
        "times_per_day": 2,
        "frequency": "12/12h",
        "duration": "7-10 dias",
        "concentration": 50,        # 250 mg / 5 mL
        "presentation": "Susp. 250mg/5mL",
        "notes": "7,5mg/kg/dose 12/12h; máx 500mg/dose (RENAME 2024)",
        "provenance": "RENAME 2024 / drugs.ts (claritromicina)",
    },
    {
        "id": "eritro_ped",
        "name": "Eritromicina",
        "category": "antibiotics",
        "dose_per_kg": 40,          # 10 mg/kg/dose x 4 (6/6h)
        "max_daily": 2000,          # 500 mg/dose x 4
        "times_per_day": 4,
        "frequency": "6/6h",
        "duration": "7-10 dias",
        "concentration": 50,        # 250 mg / 5 mL
        "presentation": "Susp. 250mg/5mL",
        "notes": "10mg/kg/dose 6/6h; máx 500mg/dose (RENAME 2024)",
        "provenance": "RENAME 2024 / drugs.ts (eritromicina-pediatrica)",
    },
    {
        "id": "ceftriaxona_ped",
        "name": "Ceftriaxona (IM/IV)",
        "category": "antibiotics",
        "dose_per_kg": 50,          # 50-75 mg/kg/dia; encoded conservador 50
        "max_daily": 2000,          # máx 2 g/dose (1x/dia, não-meningite)
        "times_per_day": 1,
        "frequency": "1x/dia",
        "duration": "a critério",
        "presentation": "Frasco-ampola 1g",
        "notes": "50-75mg/kg/dia 1x/dia; meningite 100mg/kg/dia 12/12h; máx 2g/dose (RENAME 2024)",
        "provenance": "RENAME 2024 / drugs.ts (ceftriaxona-pediatrica)",
    },
    # ── Antiparasitics (parity) ──────────────────────────────────
    {
        "id": "mebendazol_ped",
        "name": "Mebendazol",
        "category": "antiparasitics",
        "times_per_day": 2,
        "frequency": "12/12h",
        "duration": "3 dias",
        "presentation": "Susp. 20mg/mL (100mg/5mL)",
        "notes": "100mg 12/12h por 3 dias; não usar <2 anos (RENAME 2024)",
        "weight_based_doses": [
            {"min_kg": 0, "max_kg": 999, "dose_mg": 100},
        ],
        "provenance": "RENAME 2024 / drugs.ts (mebendazol, dose fixa)",
    },
    {
        "id": "ivermectina_ped",
        "name": "Ivermectina",
        "category": "antiparasitics",
        "dose_per_kg": 0.2,         # 200 mcg/kg dose única
        "max_daily": 24,            # máx 24 mg (adultos); não liga em peds
        "times_per_day": 1,
        "frequency": "dose única",
        "duration": "dose única",
        "presentation": "Comprimido 6mg",
        "notes": ">15kg: 200mcg/kg dose única; repetir 7-14 dias se escabiose (RENAME 2024)",
        "provenance": "RENAME 2024 / drugs.ts (ivermectina); contraindicada <15kg",
    },
    # ── Respiratory (parity) ─────────────────────────────────────
    {
        "id": "ipratropio_ped",
        "name": "Ipratrópio (Nebulização)",
        "category": "respiratory",
        "times_per_day": 3,         # 20/20min x 3 doses (crise)
        "frequency": "20/20min",
        "duration": "crise",
        "presentation": "Sol. 0,25mg/mL",
        "dose_unit": "mcg",
        "notes": "250mcg/dose 20/20min por 3 doses, associado ao salbutamol (drugs.ts/RENAME 2024)",
        "weight_based_doses": [
            {"min_kg": 0, "max_kg": 999, "dose_mg": 250},
        ],
        "provenance": "drugs.ts (ipratropio-nebulizacao) / RENAME 2024",
    },
    {
        "id": "budesonida_neb_ped",
        "name": "Budesonida (Nebulização)",
        "category": "respiratory",
        "times_per_day": 1,         # crupe: dose única de 2 mg
        "frequency": "1-2x/dia",
        "duration": "a critério",
        "presentation": "Susp. 0,25-0,5mg/2mL",
        "notes": "crupe: 2mg dose única; asma: 0,25-0,5mg 12/12h (drugs.ts)",
        "weight_based_doses": [
            {"min_kg": 0, "max_kg": 999, "dose_mg": 2},
        ],
        "provenance": "drugs.ts (budesonida-nebulizacao); calc usa 2mg crupe",
    },
    {
        "id": "adren_neb_ped",
        "name": "Adrenalina (Nebulização-Crupe)",
        "category": "respiratory",
        "dose_per_kg": 0.5,         # 0,5 mL/kg; sol 1:1000 = 1 mg/mL -> mL=mg
        "max_daily": 5,             # máx 5 mL
        "times_per_day": 1,
        "frequency": "SN",
        "duration": "crise",
        "concentration": 1,         # 1 mg/mL (1:1000) -> per_dose_ml = 0,5 mL/kg
        "presentation": "Sol. 1mg/mL (1:1000)",
        "notes": "0,5mL/kg (máx 5mL) diluído; repetir após 20min se necessário (drugs.ts)",
        "provenance": "drugs.ts (adrenalina-nebulizacao-crupe); 1:1000 => mL=mg",
    },
    {
        "id": "sf_nasal",
        "name": "Soro fisiológico nasal",
        "category": "respiratory",
        "frequency": "6/6h",
        "duration": "—",
        "presentation": "Sol. 0,9%",
        "no_calc": True,
        "practical_text": "Instilar (lavagem nasal)",
        "notes": "Lavagem nasal; instilar conforme necessidade. Sem cálculo de dose.",
        "provenance": "popup _MED_CATALOG_FALLBACK (sem regra de dose)",
    },
    # ── Gastrointestinal (parity) ────────────────────────────────
    {
        "id": "metoclopramida_ped",
        "name": "Metoclopramida",
        "category": "gastro",
        "dose_per_kg": 0.3,         # 0,1 mg/kg/dose x 3 (8/8h)
        "max_daily": 30,            # teto absoluto adulto; 0,3 < 0,5 mg/kg/dia
        "times_per_day": 3,
        "frequency": "8/8h",
        "duration": "SN",
        "concentration": 4,         # gotas 4 mg/mL
        "drops_per_ml": 20,
        "presentation": "Gotas 4mg/mL",
        "notes": "0,1mg/kg/dose 8/8h; máx 0,5mg/kg/dia; cautela <1a (risco extrapiramidal) (drugs.ts/RENAME 2024)",
        "provenance": "drugs.ts (metoclopramida): 0,1mg/kg/dose, máx 0,5mg/kg/dia",
    },
    {
        "id": "bromoprida_ped",
        "name": "Bromoprida",
        "category": "gastro",
        "dose_per_kg": 0.3,         # 0,1 mg/kg/dose x 3 (= 0,5 gota/kg/dose)
        "max_daily": 30,            # teto absoluto adulto
        "times_per_day": 3,
        "frequency": "8/8h",
        "duration": "SN",
        "concentration": 4,         # gotas 4 mg/mL
        "drops_per_ml": 20,
        "presentation": "Gotas 4mg/mL",
        "notes": "0,5-1 gota/kg/dose 8/8h (drugs.ts/Anvisa bula)",
        "provenance": "drugs.ts (bromoprida): VO 1gt/kg/dose, primário 0,1mg/kg/dose",
    },
    {
        "id": "lactulose_ped",
        "name": "Lactulose",
        "category": "gastro",
        "dose_per_kg": 266.8,       # 0,4 mL/kg/dia x 667 mg/mL (xarope)
        "max_daily": 40020,         # 60 mL/dia x 667 mg/mL
        "times_per_day": 1,
        "frequency": "1-2x/dia",
        "duration": "a critério",
        "concentration": 667,       # 667 mg/mL -> recupera 0,4 mL/kg/dia
        "presentation": "Xarope 667mg/mL",
        "notes": "0,4mL/kg/dia ÷ 1-2x; ajustar pela resposta (drugs.ts/RENAME 2024)",
        "provenance": "drugs.ts (lactulose): 0,4mL/kg/dia, máx 60mL/dia, 667mg/mL",
    },
    {
        "id": "simeticona_ped",
        "name": "Simeticona",
        "category": "gastro",
        "dose_per_kg": 15,          # 1 gota/kg/dose x 4 (75mg/mL, 20 gt/mL)
        "max_daily": 180,           # 12 gotas/dose x 4 ~ 180 mg
        "times_per_day": 4,
        "frequency": "6/6h",
        "duration": "SN",
        "concentration": 75,        # gotas 75 mg/mL
        "drops_per_ml": 20,
        "practical_rule": "1 gota/kg",
        "presentation": "Gotas 75mg/mL",
        "notes": "~1 gota/kg/dose 6/6h após mamadas; máx 12 gotas/dose (drugs.ts/Anvisa bula)",
        "provenance": "drugs.ts (dimeticona/simeticona): 1 gota/kg/dose, máx 12 gt/dose",
    },
    # ── Supplements (parity) ─────────────────────────────────────
    {
        "id": "acido_folico_ped",
        "name": "Ácido Fólico",
        "category": "supplements",
        "times_per_day": 1,
        "frequency": "1x/dia",
        "duration": "a critério",
        "presentation": "Sol. oral 0,2mg/mL",
        "notes": "profilaxia 0,4mg/dia; terapêutico conforme idade (RENAME 2024)",
        "weight_based_doses": [
            {"min_kg": 0, "max_kg": 999, "dose_mg": 0.4},
        ],
        "provenance": "RENAME 2024 / drugs.ts (acido-folico); profilaxia 0,4mg/dia",
    },
    # ── Others (parity) ──────────────────────────────────────────
    {
        "id": "adren_im_ped",
        "name": "Adrenalina IM (Anafilaxia)",
        "category": "others",
        "dose_per_kg": 0.01,        # 0,01 mg/kg IM
        "max_daily": 0.3,           # máx 0,3 mg/dose (< 30kg)
        "times_per_day": 1,
        "frequency": "SN",
        "duration": "crise",
        "presentation": "Amp. 1mg/mL (1:1000)",
        "notes": "0,01mg/kg IM (máx 0,3mg); repetir 5-15min se necessário (drugs.ts/RENAME 2024)",
        "provenance": "drugs.ts (adrenalina-im-anafilaxia): 0,01mg/kg, máx 0,3mg <30kg",
    },
    # -- Antibiotics (batch 2/2 remaining) ---------------------
    {
        "id": "benzatina_ped",
        "name": "Penicilina Benzatina (IM)",
        "category": "antibiotics",
        "times_per_day": 1,
        "frequency": "dose unica",
        "duration": "dose unica",
        "presentation": "Frasco 600.000 UI",
        "dose_unit": "UI",
        "notes": "50.000 UI/kg dose unica IM; max 1.200.000 UI (RENAME 2024)",
        "weight_based_doses": [
            {"min_kg": 0, "max_kg": 27, "dose_mg": 600000},
            {"min_kg": 27, "max_kg": 999, "dose_mg": 1200000},
        ],
        "provenance": "RENAME 2024 / SBP; encode ~50.000UI/kg via peso tiers",
    },
    # -- Antiparasitics (batch 2/2 remaining) ---------------------
    # -- Antifungals (batch 2/2) ----------------------------------
    {
        "id": "nistatina_ped",
        "name": "Nistatina (oral)",
        "category": "antifungals",
        "times_per_day": 4,
        "frequency": "6/6h",
        "duration": "7-14 dias",
        "presentation": "Susp. 100.000 UI/mL",
        "dose_unit": "UI",
        "notes": "100.000 UI (1mL) 4-6/6h, bochechar/deglutir (RENAME 2024)",
        "weight_based_doses": [
            {"min_kg": 0, "max_kg": 999, "dose_mg": 100000},
        ],
        "provenance": "RENAME 2024 / drugs.ts (nistatina-ped); dose fixa 100.000 UI",
    },
    # -- Corticoids (batch 2/2) -----------------------------------
    {
        "id": "dexa_ped",
        "name": "Dexametasona",
        "category": "corticoids",
        "dose_per_kg": 0.15,        # conservativo 0,15mg/kg dose unica (crupe)
        "max_daily": 16,            # max 16mg
        "times_per_day": 1,
        "frequency": "dose unica",
        "duration": "1-4 dias",
        "concentration": 0.1,       # elixir 0,1mg/mL
        "presentation": "Elixir 0,1mg/mL",
        "notes": "crupe 0,15-0,6mg/kg dose unica; max 16mg (drugs.ts/RENAME 2024)",
        "provenance": "drugs.ts/RENAME 2024 (dexametasona-crupe); 0,15mg/kg conservativo",
    },
    # -- Antihistamines (batch 2/2) -------------------------------
    {
        "id": "loratadina_ped",
        "name": "Loratadina",
        "category": "antihistamines",
        "times_per_day": 1,
        "frequency": "1x/dia",
        "duration": "a criterio",
        "concentration": 1,         # xarope 1mg/mL
        "presentation": "Xarope 1mg/mL",
        "notes": "2-12a: 5mg/dia (>30kg: 10mg/dia) (RENAME/Anvisa bula)",
        "weight_based_doses": [
            {"min_kg": 0, "max_kg": 30, "dose_mg": 5},
            {"min_kg": 30, "max_kg": 999, "dose_mg": 10},
        ],
        "provenance": "RENAME 2024 / Anvisa bula (loratadina-ped); tiers 5/10mg",
    },
    {
        "id": "desloratadine_ped",
        "name": "Desloratadina",
        "category": "antihistamines",
        "times_per_day": 1,
        "frequency": "1x/dia",
        "duration": "a criterio",
        "concentration": 0.5,       # xarope 0,5mg/mL
        "presentation": "Xarope 0,5mg/mL",
        "notes": "1-5a: 1,25mg; 6-11a: 2,5mg; >12a: 5mg/dia (Anvisa bula)",
        "weight_based_doses": [
            {"min_kg": 0, "max_kg": 20, "dose_mg": 1.25},
            {"min_kg": 20, "max_kg": 40, "dose_mg": 2.5},
            {"min_kg": 40, "max_kg": 999, "dose_mg": 5},
        ],
        "provenance": "Anvisa bula (desloratadina-ped); tiers 1,25/2,5/5mg por peso",
    },
    {
        "id": "hidroxizina_ped",
        "name": "Hidroxizina",
        "category": "antihistamines",
        "dose_per_kg": 1.5,         # 0,5mg/kg/dose x 3 (8/8h) = 1,5mg/kg/dia
        "max_daily": 75,            # max 25mg/dose x 3
        "times_per_day": 3,
        "frequency": "8/8h",
        "duration": "a criterio",
        "concentration": 2,         # xarope 2mg/mL
        "presentation": "Xarope 2mg/mL",
        "notes": "0,5-1mg/kg/dose 6-8/8h; max 25mg/dose (drugs.ts/RENAME 2024)",
        "provenance": "drugs.ts/RENAME 2024 (hidroxizina-ped); 0,5mg/kg conservativo",
    },
    # -- Gastro (batch 2/2) ---------------------------------------
    {
        "id": "ondansetrona_ped",
        "name": "Ondansetrona",
        "category": "gastro",
        "times_per_day": 1,
        "frequency": "8/8h",
        "duration": "SN",
        "concentration": 0.8,       # sol 4mg/5mL = 0,8mg/mL
        "presentation": "Comp. 4mg / Sol. 4mg/5mL",
        "notes": "0,15mg/kg/dose; gastroenterite: dose unica VO; max 8mg (drugs.ts/RENAME 2024)",
        "weight_based_doses": [
            {"min_kg": 0, "max_kg": 15, "dose_mg": 2},
            {"min_kg": 15, "max_kg": 40, "dose_mg": 4},
            {"min_kg": 40, "max_kg": 999, "dose_mg": 8},
        ],
        "provenance": "drugs.ts/RENAME 2024 (ondansetrona-ped); tiers 2/4/8mg por peso",
    },
    # -- Supplements (batch 2/2) ----------------------------------
    {
        "id": "sulfato_ferroso_ped",
        "name": "Sulfato Ferroso",
        "category": "supplements",
        "dose_per_kg": 3,           # terapeutico 3mg/kg/dia Fe elementar (conservativo)
        "max_daily": 200,           # teto pratico
        "times_per_day": 1,
        "frequency": "1x/dia",
        "duration": "a criterio",
        "concentration": 25,        # gotas 25mg Fe/mL
        "drops_per_ml": 20,
        "presentation": "Gotas 25mg Fe/mL",
        "notes": "3-5mg/kg/dia (Fe elementar) terapeutico; profilaxia 1-2mg/kg/dia (RENAME 2024/SBP)",
        "provenance": "RENAME 2024 / SBP (sulfato-ferroso-ped); 3mg/kg/dia conservativo",
    },
    {
        "id": "sulfato_zinco_ped",
        "name": "Sulfato de Zinco (Diarreia)",
        "category": "supplements",
        "times_per_day": 1,
        "frequency": "1x/dia",
        "duration": "10-14 dias",
        "concentration": 4,         # sol oral 4mg/mL
        "presentation": "Sol. oral 4mg/mL",
        "notes": "diarreia aguda: <6m 10mg/dia, >6m 20mg/dia por 10-14 dias (MS/SBP)",
        "weight_based_doses": [
            {"min_kg": 0, "max_kg": 7, "dose_mg": 10},
            {"min_kg": 7, "max_kg": 999, "dose_mg": 20},
        ],
        "provenance": "MS/SBP (sulfato-zinco-ped); <6m ~<7kg tiers",
    },
]

# Adult medications — fixed-dose catalog used by Toca Ficha Dr. v3.4.0 smart
# templates. No weight-based multiplier; doses come straight from the catalog.
ADULT_MEDICATIONS = [
    # ── Analgesics / Antipyretics ────────────────────────────────
    {
        "id": "dipyrone_adult",
        "name": "Dipirona",
        "category": "analgesics",
        "fixed_dose_mg": 1000,
        "fixed_dose_text": "500mg-1g",
        "frequency": "6/6h",
        "duration": "SN",
        "presentation": "Comp. 500mg ou Gotas 500mg/mL",
        "notes": "Febre, dor moderada",
    },
    {
        "id": "paracetamol_adult",
        "name": "Paracetamol",
        "category": "analgesics",
        "fixed_dose_mg": 750,
        "fixed_dose_text": "500-750mg",
        "frequency": "6/6h",
        "duration": "SN",
        "presentation": "Comp. 500/750mg",
        "notes": "Febre, dor leve",
    },
    {
        "id": "ibuprofen_adult",
        "name": "Ibuprofeno",
        "category": "analgesics",
        "fixed_dose_mg": 600,
        "fixed_dose_text": "400-600mg",
        "frequency": "8/8h",
        "duration": "SN",
        "presentation": "Comp. 400/600mg",
        "notes": "Dor, processo inflamatório",
    },
    {
        "id": "diclofenac_adult",
        "name": "Diclofenaco",
        "category": "analgesics",
        "fixed_dose_mg": 50,
        "fixed_dose_text": "50mg",
        "frequency": "8/8h",
        "duration": "SN",
        "presentation": "Comp. 50mg",
        "notes": "Dor musculoesquelética. Atenção: GI/CV",
    },
    {
        "id": "tramadol_adult",
        "name": "Tramadol",
        "category": "analgesics",
        "fixed_dose_mg": 100,
        "fixed_dose_text": "50-100mg",
        "frequency": "6/6h",
        "duration": "SN",
        "presentation": "Comp. 50mg ou Gotas 100mg/mL",
        "notes": "Dor moderada-intensa",
    },
    # ── Antibiotics ──────────────────────────────────────────────
    {
        "id": "amox_adult",
        "name": "Amoxicilina 500mg",
        "category": "antibiotics",
        "fixed_dose_mg": 500,
        "fixed_dose_text": "500mg",
        "frequency": "8/8h",
        "duration": "7 dias",
        "presentation": "Cápsula 500mg",
        "notes": "Faringite, OMA, sinusite",
    },
    {
        "id": "amox_clav_adult",
        "name": "Amoxicilina + Clavulanato",
        "category": "antibiotics",
        "fixed_dose_mg": 875,
        "fixed_dose_text": "875/125mg",
        "frequency": "12/12h",
        "duration": "7-10 dias",
        "presentation": "Comp. 875/125mg",
        "notes": "OMA refratária, sinusite, mordeduras",
    },
    {
        "id": "cephalexin_adult",
        "name": "Cefalexina",
        "category": "antibiotics",
        "fixed_dose_mg": 500,
        "fixed_dose_text": "500mg",
        "frequency": "6/6h",
        "duration": "7 dias",
        "presentation": "Cápsula 500mg",
        "notes": "ITU, infecções de pele",
    },
    {
        "id": "azithromycin_adult",
        "name": "Azitromicina",
        "category": "antibiotics",
        "fixed_dose_mg": 500,
        "fixed_dose_text": "500mg",
        "frequency": "1x/dia",
        "duration": "5 dias",
        "presentation": "Comp. 500mg",
        "notes": "Pneumonia atípica, faringite (alergia a beta-lactâmico)",
    },
    {
        "id": "ciprofloxacin_adult",
        "name": "Ciprofloxacino",
        "category": "antibiotics",
        "fixed_dose_mg": 500,
        "fixed_dose_text": "500mg",
        "frequency": "12/12h",
        "duration": "7-14 dias",
        "presentation": "Comp. 500mg",
        "notes": "ITU complicada, GE bacteriana",
    },
    {
        "id": "nitrofurantoin_adult",
        "name": "Nitrofurantoína",
        "category": "antibiotics",
        "fixed_dose_mg": 100,
        "fixed_dose_text": "100mg",
        "frequency": "6/6h",
        "duration": "7 dias",
        "presentation": "Cápsula 100mg",
        "notes": "ITU não-complicada",
    },
    {
        "id": "sulfa_tmp_adult",
        "name": "Sulfametoxazol+Trimetoprima",
        "category": "antibiotics",
        "fixed_dose_mg": None,
        "fixed_dose_text": "800/160mg",
        "frequency": "12/12h",
        "duration": "3-5 dias",
        "presentation": "Comp. 800/160mg",
        "notes": "ITU, profilaxia. Atenção: alergia a sulfa",
    },
    # ── Others ───────────────────────────────────────────────────
    {
        "id": "omeprazole_adult",
        "name": "Omeprazol",
        "category": "others",
        "fixed_dose_mg": 20,
        "fixed_dose_text": "20-40mg",
        "frequency": "1x/dia",
        "duration": "Variável",
        "presentation": "Cápsula 20mg",
        "notes": "Antes do café da manhã",
    },
    {
        "id": "ondansetron_adult",
        "name": "Ondansetrona",
        "category": "others",
        "fixed_dose_mg": 4,
        "fixed_dose_text": "4-8mg",
        "frequency": "8/8h",
        "duration": "SN",
        "presentation": "Comp. 4mg ou Sub-lingual 4mg",
        "notes": "Êmese, náusea pós-quimio",
    },
    {
        "id": "bromopride_adult",
        "name": "Bromoprida",
        "category": "others",
        "fixed_dose_mg": 10,
        "fixed_dose_text": "10mg",
        "frequency": "8/8h",
        "duration": "SN",
        "presentation": "Comp. 10mg ou Gotas 4mg/mL",
        "notes": "Náusea, dispepsia. Atenção: extrapiramidal",
    },
    {
        "id": "hyoscine_adult",
        "name": "Hyoscina (Buscopan)",
        "category": "others",
        "fixed_dose_mg": 10,
        "fixed_dose_text": "10-20mg",
        "frequency": "6/6h",
        "duration": "SN",
        "presentation": "Comp. 10mg",
        "notes": "Cólica abdominal, dismenorreia",
    },
    {
        "id": "loratadine_adult",
        "name": "Loratadina",
        "category": "others",
        "fixed_dose_mg": 10,
        "fixed_dose_text": "10mg",
        "frequency": "1x/dia",
        "duration": "Variável",
        "presentation": "Comp. 10mg",
        "notes": "Rinite, urticária",
    },
    {
        "id": "salbutamol_inh_adult",
        "name": "Salbutamol (Aerosol)",
        "category": "others",
        "fixed_dose_mg": None,
        "fixed_dose_text": "200mcg",
        "frequency": "4/4h",
        "duration": "Crise",
        "presentation": "Aerosol 100mcg/jato",
        "notes": "2 jatos/dose, espaçador recomendado",
    },
    # ── Corticosteroids ──────────────────────────────────────────
    {
        "id": "prednisone_adult",
        "name": "Prednisona",
        "category": "corticoids",
        "fixed_dose_mg": 40,
        "fixed_dose_text": "20-40mg",
        "frequency": "1x/dia",
        "duration": "3-5 dias",
        "presentation": "Comp. 20mg",
        "notes": "Asma, alergia, exacerbação DPOC",
    },
    {
        "id": "dexamethasone_adult",
        "name": "Dexametasona",
        "category": "corticoids",
        "fixed_dose_mg": 8,
        "fixed_dose_text": "4-8mg",
        "frequency": "1x/dia",
        "duration": "DU ou 1-2 dias",
        "presentation": "Comp. 4mg ou IM 4mg/mL",
        "notes": "Crupe, asma severa",
    },
    # ── CHRA-2048: online-picker parity additions (RENAME 2024 / popup _MED_CATALOG_FALLBACK) ──
    {
        "id": "levoflox_adult",
        "name": "Levofloxacino 500mg",
        "category": "antibiotics",
        "fixed_dose_mg": 500,
        "fixed_dose_text": "1 cp",
        "frequency": "1x/dia",
        "duration": "7 dias",
        "presentation": "Comprimido 500mg",
        "notes": "500-750mg 1x/dia (RENAME 2024)",
    },
    {
        "id": "metronidazol_adult",
        "name": "Metronidazol 250mg",
        "category": "antibiotics",
        "fixed_dose_mg": 250,
        "fixed_dose_text": "2 cp (500mg)",
        "frequency": "8/8h",
        "duration": "7 dias",
        "presentation": "Comprimido 250mg",
        "notes": "500mg 8/8h; máx 1,5g/dia; evitar álcool (RENAME 2024)",
    },
    {
        "id": "doxiciclina_adult",
        "name": "Doxiciclina 100mg",
        "category": "antibiotics",
        "fixed_dose_mg": 100,
        "fixed_dose_text": "100mg",
        "frequency": "12/12h",
        "duration": "7 dias",
        "presentation": "Comprimido 100mg",
        "notes": "100mg 12/12h (RENAME 2024)",
    },
    {
        "id": "claritro_adult",
        "name": "Claritromicina 500mg",
        "category": "antibiotics",
        "fixed_dose_mg": 500,
        "fixed_dose_text": "1 cp",
        "frequency": "12/12h",
        "duration": "7-14 dias",
        "presentation": "Comprimido 500mg",
        "notes": "500mg 12/12h; máx 1g/dia (RENAME 2024)",
    },
    {
        "id": "clinda_adult",
        "name": "Clindamicina 300mg",
        "category": "antibiotics",
        "fixed_dose_mg": 300,
        "fixed_dose_text": "1 cp",
        "frequency": "6/6h",
        "duration": "7-10 dias",
        "presentation": "Cápsula 300mg",
        "notes": "300mg 6/6h VO (RENAME 2024)",
    },
    {
        "id": "ceftriaxona_adult",
        "name": "Ceftriaxona 1g (IM/IV)",
        "category": "antibiotics",
        "fixed_dose_mg": 1000,
        "fixed_dose_text": "1g IM/IV",
        "frequency": "1x/dia",
        "duration": "a critério",
        "presentation": "Frasco-ampola 1g",
        "notes": "1-2g 1x/dia; meningite 2g 12/12h; máx 4g/dia (RENAME 2024)",
    },
    {
        "id": "benzatina_adult",
        "name": "Penicilina Benzatina 1.200.000 UI (IM)",
        "category": "antibiotics",
        "fixed_dose_mg": None,
        "fixed_dose_text": "1.200.000-2.400.000 UI IM",
        "frequency": "dose única",
        "duration": "dose única",
        "presentation": "Frasco 1.200.000 UI",
        "notes": "sífilis recente 2,4M UI dose única; tardia 2,4M/semana 3 doses (RENAME 2024)",
    },
    {
        "id": "albendazol_adult",
        "name": "Albendazol 400mg",
        "category": "antiparasitics",
        "fixed_dose_mg": 400,
        "fixed_dose_text": "400mg",
        "frequency": "1x/dia",
        "duration": "1-3 dias",
        "presentation": "Comprimido 400mg",
        "notes": "400mg dose única (helmintos); 3 dias p/ alguns; repetir 7-14d (RENAME 2024)",
    },
    {
        "id": "mebendazol_adult",
        "name": "Mebendazol 100mg",
        "category": "antiparasitics",
        "fixed_dose_mg": 100,
        "fixed_dose_text": "100mg",
        "frequency": "12/12h",
        "duration": "3 dias",
        "presentation": "Comprimido 100mg",
        "notes": "100mg 12/12h por 3 dias (RENAME 2024)",
    },
    {
        "id": "ivermectina_adult",
        "name": "Ivermectina 6mg",
        "category": "antiparasitics",
        "fixed_dose_mg": 6,
        "fixed_dose_text": "200 mcg/kg",
        "frequency": "dose única",
        "duration": "dose única",
        "presentation": "Comprimido 6mg",
        "notes": "200mcg/kg dose única; repetir 7-14 dias em escabiose (RENAME 2024)",
    },
    {
        "id": "nistatina_adult",
        "name": "Nistatina 100.000 UI/mL",
        "category": "antifungals",
        "fixed_dose_mg": None,
        "fixed_dose_text": "5 mL (bochechar/deglutir)",
        "frequency": "6/6h",
        "duration": "7-14 dias",
        "presentation": "Susp. oral 100.000 UI/mL",
        "notes": "500.000 UI (5mL) 4-6/6h (RENAME 2024)",
    },
    {
        "id": "fluconazol_adult",
        "name": "Fluconazol 150mg",
        "category": "antifungals",
        "fixed_dose_mg": 150,
        "fixed_dose_text": "150mg",
        "frequency": "1x/dia",
        "duration": "1-7 dias",
        "presentation": "Cápsula 150mg",
        "notes": "candidíase vaginal 150mg dose única; sistêmica 1x/dia (RENAME 2024)",
    },
    {
        "id": "aas_adult",
        "name": "Ácido Acetilsalicílico (AAS)",
        "category": "analgesics",
        "fixed_dose_mg": None,
        "fixed_dose_text": "1 cp",
        "frequency": "4-6/6h",
        "duration": "SN",
        "presentation": "Comprimido 500mg",
        "notes": "analgésico 500mg 4-6/6h; antiplaquetário 100mg/dia (RENAME 2024)",
    },
    {
        "id": "cetoprofeno_adult",
        "name": "Cetoprofeno 100mg",
        "category": "analgesics",
        "fixed_dose_mg": 100,
        "fixed_dose_text": "1 cp",
        "frequency": "12/12h",
        "duration": "5 dias",
        "presentation": "Comprimido 100mg",
        "notes": "100mg 8-12/12h; máx 300mg/dia (RENAME 2024)",
    },
    {
        "id": "betametasona_adult",
        "name": "Betametasona 0,5mg",
        "category": "corticoids",
        "fixed_dose_mg": 0.5,
        "fixed_dose_text": "1 cp",
        "frequency": "12/12h",
        "duration": "a critério",
        "presentation": "Comprimido 0,5mg",
        "notes": "0,5mg 12-24/24h; ação longa (RENAME 2024)",
    },
    {
        "id": "hidrocortisona_adult",
        "name": "Hidrocortisona (IV/IM)",
        "category": "corticoids",
        "fixed_dose_mg": 200,
        "fixed_dose_text": "100-200mg IV",
        "frequency": "6/6h",
        "duration": "a critério",
        "presentation": "Frasco-ampola 100/500mg",
        "notes": "anafilaxia/asma grave 100-200mg IV; máx 500mg/dose (drugs.ts/RENAME 2024)",
    },
    {
        "id": "desloratadine_adult",
        "name": "Desloratadina 5mg",
        "category": "antihistamines",
        "fixed_dose_mg": 5,
        "fixed_dose_text": "1 cp",
        "frequency": "1x/dia",
        "duration": "a critério",
        "presentation": "Comprimido 5mg",
        "notes": "5mg 1x/dia (Anvisa bula)",
    },
    {
        "id": "hidroxizina_adult",
        "name": "Hidroxizina 25mg",
        "category": "antihistamines",
        "fixed_dose_mg": 25,
        "fixed_dose_text": "1 cp",
        "frequency": "8/8h",
        "duration": "a critério",
        "presentation": "Comprimido 25mg",
        "notes": "25mg 6-8/8h; sedativo (RENAME 2024)",
    },
    {
        "id": "prometazina_adult",
        "name": "Prometazina 25mg",
        "category": "antihistamines",
        "fixed_dose_mg": 25,
        "fixed_dose_text": "1 cp",
        "frequency": "8/8h",
        "duration": "SN",
        "presentation": "Comprimido 25mg",
        "notes": "25mg 8-12/12h; contraindicada <2 anos (RENAME 2024)",
    },
    {
        "id": "ipratropio_adult",
        "name": "Ipratrópio (Nebulização)",
        "category": "respiratory",
        "fixed_dose_mg": 0.5,
        "fixed_dose_text": "40 gotas (0,5mg) + SF",
        "frequency": "20/20min",
        "duration": "crise",
        "presentation": "Sol. 0,25mg/mL",
        "notes": "0,5mg 20/20min por 3 doses, associado ao salbutamol (RENAME 2024)",
    },
    {
        "id": "pantoprazol_adult",
        "name": "Pantoprazol 40mg",
        "category": "gastro",
        "fixed_dose_mg": 40,
        "fixed_dose_text": "1 cp",
        "frequency": "1x/dia",
        "duration": "a critério",
        "presentation": "Comprimido 40mg",
        "notes": "40mg/dia (manhã, jejum) (RENAME 2024)",
    },
    {
        "id": "metoclopramida_adult",
        "name": "Metoclopramida 10mg",
        "category": "gastro",
        "fixed_dose_mg": 10,
        "fixed_dose_text": "10mg",
        "frequency": "8/8h",
        "duration": "SN",
        "presentation": "Comprimido 10mg / Gotas 4mg/mL",
        "notes": "10mg 8/8h; máx 30mg/dia (RENAME 2024)",
    },
    {
        "id": "dimenidrinato_adult",
        "name": "Dimenidrinato + B6",
        "category": "gastro",
        "fixed_dose_mg": None,
        "fixed_dose_text": "1 cp",
        "frequency": "6/6h",
        "duration": "SN",
        "presentation": "Comprimido 50mg",
        "notes": "50mg 6/6h (cinetose/náusea) (RENAME/Anvisa bula)",
    },
    {
        "id": "lactulose_adult",
        "name": "Lactulose",
        "category": "gastro",
        "fixed_dose_mg": None,
        "fixed_dose_text": "15 mL",
        "frequency": "1-3x/dia",
        "duration": "a critério",
        "presentation": "Xarope 667mg/mL",
        "notes": "15-30mL 1-3x/dia; ajustar pela resposta (RENAME 2024)",
    },
    {
        "id": "loperamida_adult",
        "name": "Loperamida 2mg",
        "category": "gastro",
        "fixed_dose_mg": 2,
        "fixed_dose_text": "2mg após evacuação",
        "frequency": "SN",
        "duration": "SN",
        "presentation": "Comprimido 2mg",
        "notes": "4mg inicial, 2mg após cada evacuação líquida; máx 16mg/dia (RENAME 2024)",
    },
    {
        "id": "hidroxido_aluminio_adult",
        "name": "Hidróxido de Alumínio",
        "category": "gastro",
        "fixed_dose_mg": None,
        "fixed_dose_text": "15 mL",
        "frequency": "4-6/6h",
        "duration": "SN",
        "presentation": "Susp. oral",
        "notes": "antiácido; afastar de outros fármacos (RENAME 2024)",
    },
    {
        "id": "simeticona_adult",
        "name": "Simeticona 40mg",
        "category": "gastro",
        "fixed_dose_mg": 40,
        "fixed_dose_text": "40-125mg",
        "frequency": "6/6h",
        "duration": "SN",
        "presentation": "Comprimido 40mg / Gotas 75mg/mL",
        "notes": "40-125mg 6/6h após refeições (Anvisa bula)",
    },
    {
        "id": "losartana",
        "name": "Losartana 50mg",
        "category": "cardio",
        "fixed_dose_mg": 50,
        "fixed_dose_text": "1 cp",
        "frequency": "1x/dia",
        "duration": "—",
        "presentation": "Comprimido 50mg",
        "notes": "50mg 1x/dia; máx 100mg/dia (RENAME 2024)",
    },
    {
        "id": "enalapril_adult",
        "name": "Enalapril 10mg",
        "category": "cardio",
        "fixed_dose_mg": 10,
        "fixed_dose_text": "1 cp",
        "frequency": "12/12h",
        "duration": "—",
        "presentation": "Comprimido 10mg",
        "notes": "10-20mg 12/12h; máx 40mg/dia (RENAME 2024)",
    },
    {
        "id": "captopril_adult",
        "name": "Captopril 25mg",
        "category": "cardio",
        "fixed_dose_mg": 25,
        "fixed_dose_text": "1 cp",
        "frequency": "8/8h",
        "duration": "—",
        "presentation": "Comprimido 25mg",
        "notes": "25mg 8/8h; emergência: 25mg SL dose única (RENAME 2024)",
    },
    {
        "id": "anlodipino_adult",
        "name": "Anlodipino 5mg",
        "category": "cardio",
        "fixed_dose_mg": 5,
        "fixed_dose_text": "1 cp",
        "frequency": "1x/dia",
        "duration": "—",
        "presentation": "Comprimido 5mg",
        "notes": "5mg 1x/dia; máx 10mg/dia (RENAME 2024)",
    },
    {
        "id": "hidroclorotiazida_adult",
        "name": "Hidroclorotiazida 25mg",
        "category": "cardio",
        "fixed_dose_mg": 25,
        "fixed_dose_text": "1 cp",
        "frequency": "1x/dia",
        "duration": "—",
        "presentation": "Comprimido 25mg",
        "notes": "25mg 1x/dia (manhã); máx 50mg/dia (RENAME 2024)",
    },
    {
        "id": "furosemida_adult",
        "name": "Furosemida 40mg",
        "category": "cardio",
        "fixed_dose_mg": 40,
        "fixed_dose_text": "1 cp",
        "frequency": "1x/dia",
        "duration": "a critério",
        "presentation": "Comprimido 40mg",
        "notes": "40mg 1-2x/dia conforme resposta (RENAME 2024)",
    },
    {
        "id": "espironolactona_adult",
        "name": "Espironolactona 25mg",
        "category": "cardio",
        "fixed_dose_mg": 25,
        "fixed_dose_text": "1 cp",
        "frequency": "1x/dia",
        "duration": "—",
        "presentation": "Comprimido 25mg",
        "notes": "25-100mg/dia (RENAME 2024)",
    },
    {
        "id": "propranolol_adult",
        "name": "Propranolol 40mg",
        "category": "cardio",
        "fixed_dose_mg": 40,
        "fixed_dose_text": "1 cp",
        "frequency": "8/8h",
        "duration": "—",
        "presentation": "Comprimido 40mg",
        "notes": "40mg 8-12/12h; titular (RENAME 2024)",
    },
    {
        "id": "carvedilol_adult",
        "name": "Carvedilol 6,25mg",
        "category": "cardio",
        "fixed_dose_mg": 6.25,
        "fixed_dose_text": "1 cp",
        "frequency": "12/12h",
        "duration": "—",
        "presentation": "Comprimido 6,25mg",
        "notes": "6,25mg 12/12h; titular até 25mg 12/12h (RENAME 2024)",
    },
    {
        "id": "metildopa_adult",
        "name": "Metildopa 250mg",
        "category": "cardio",
        "fixed_dose_mg": 250,
        "fixed_dose_text": "1 cp",
        "frequency": "8/8h",
        "duration": "—",
        "presentation": "Comprimido 250mg",
        "notes": "250mg 8-12/12h; opção na gestação (RENAME 2024)",
    },
    {
        "id": "nifedipino_adult",
        "name": "Nifedipino Retard 20mg",
        "category": "cardio",
        "fixed_dose_mg": 20,
        "fixed_dose_text": "1 cp",
        "frequency": "12/12h",
        "duration": "—",
        "presentation": "Comprimido 20mg",
        "notes": "20mg 12/12h (liberação prolongada) (RENAME 2024)",
    },
    {
        "id": "sinvastatina_adult",
        "name": "Sinvastatina 20mg",
        "category": "cardio",
        "fixed_dose_mg": 20,
        "fixed_dose_text": "1 cp",
        "frequency": "1x/dia",
        "duration": "—",
        "presentation": "Comprimido 20mg",
        "notes": "20-40mg 1x/dia (à noite) (RENAME 2024)",
    },
    {
        "id": "clopidogrel_adult",
        "name": "Clopidogrel 75mg",
        "category": "cardio",
        "fixed_dose_mg": 75,
        "fixed_dose_text": "1 cp",
        "frequency": "1x/dia",
        "duration": "—",
        "presentation": "Comprimido 75mg",
        "notes": "75mg 1x/dia (RENAME 2024)",
    },
    {
        "id": "digoxina_adult",
        "name": "Digoxina 0,25mg",
        "category": "cardio",
        "fixed_dose_mg": 0.25,
        "fixed_dose_text": "1 cp",
        "frequency": "1x/dia",
        "duration": "—",
        "presentation": "Comprimido 0,25mg",
        "notes": "0,125-0,25mg/dia (manutenção) (RENAME 2024)",
    },
    {
        "id": "metformina_adult",
        "name": "Metformina 850mg",
        "category": "endocrine",
        "fixed_dose_mg": 850,
        "fixed_dose_text": "1 cp",
        "frequency": "12/12h",
        "duration": "—",
        "presentation": "Comprimido 850mg",
        "notes": "iniciar 1x/dia, titular; máx 2.550mg/dia (RENAME 2024)",
    },
    {
        "id": "glibenclamida_adult",
        "name": "Glibenclamida 5mg",
        "category": "endocrine",
        "fixed_dose_mg": 5,
        "fixed_dose_text": "1 cp",
        "frequency": "1x/dia",
        "duration": "—",
        "presentation": "Comprimido 5mg",
        "notes": "5mg/dia (antes do café); máx 20mg/dia (RENAME 2024)",
    },
    {
        "id": "insulina_nph_adult",
        "name": "Insulina NPH (SC)",
        "category": "endocrine",
        "fixed_dose_mg": None,
        "fixed_dose_text": "0,3 UI/kg/dia inicial",
        "frequency": "1-2x/dia",
        "duration": "—",
        "presentation": "Frasco 100 UI/mL",
        "notes": "dose total diária ~0,3 UI/kg, ajustar pela glicemia (RENAME 2024)",
    },
    {
        "id": "sulfato_ferroso_adult",
        "name": "Sulfato Ferroso 40mg Fe",
        "category": "supplements",
        "fixed_dose_mg": 40,
        "fixed_dose_text": "1 drágea",
        "frequency": "1x/dia",
        "duration": "a critério",
        "presentation": "Drágea 40mg Fe (200mg)",
        "notes": "40-120mg Fe/dia; profilaxia gestante 40mg/dia (RENAME 2024)",
    },
    {
        "id": "acido_folico_adult",
        "name": "Ácido Fólico 5mg",
        "category": "supplements",
        "fixed_dose_mg": 5,
        "fixed_dose_text": "1 cp",
        "frequency": "1x/dia",
        "duration": "a critério",
        "presentation": "Comprimido 5mg",
        "notes": "5mg/dia; gestação/profilaxia 0,4mg/dia (RENAME 2024)",
    },
    {
        "id": "calcio_vitd_adult",
        "name": "Carbonato de Cálcio + Vit. D",
        "category": "supplements",
        "fixed_dose_mg": None,
        "fixed_dose_text": "1 cp",
        "frequency": "1x/dia",
        "duration": "a critério",
        "presentation": "Comprimido 600mg Ca + 400UI D",
        "notes": "600mg cálcio elementar/dia ÷ 1-2x (RENAME 2024)",
    },
    {
        "id": "ciclo_adult",
        "name": "Ciclobenzaprina 5mg",
        "category": "others",
        "fixed_dose_mg": 5,
        "fixed_dose_text": "1 cp",
        "frequency": "à noite",
        "duration": "5 dias",
        "presentation": "Comprimido 5mg",
        "notes": "5-10mg à noite; relaxante muscular (RENAME/Anvisa bula)",
    },
    {
        "id": "sertralina_adult",
        "name": "Sertralina 50mg",
        "category": "others",
        "fixed_dose_mg": 50,
        "fixed_dose_text": "1 cp",
        "frequency": "1x/dia",
        "duration": "—",
        "presentation": "Comprimido 50mg",
        "notes": "50mg/dia (manhã); titular até 200mg/dia (RENAME 2024)",
    },
    {
        "id": "clorexidina_adult",
        "name": "Clorexidina 0,12% (Bucal)",
        "category": "others",
        "fixed_dose_mg": None,
        "fixed_dose_text": "bochechar 15mL",
        "frequency": "12/12h",
        "duration": "a critério",
        "presentation": "Sol. bucal 0,12%",
        "notes": "antisséptico bucal 2x/dia (RENAME 2024)",
    },
    {
        "id": "adren_im_adult",
        "name": "Adrenalina IM (Anafilaxia)",
        "category": "others",
        "fixed_dose_mg": 0.5,
        "fixed_dose_text": "0,5mg IM (0,5mL)",
        "frequency": "SN",
        "duration": "crise",
        "presentation": "Amp. 1mg/mL (1:1000)",
        "notes": "0,3-0,5mg IM coxa; repetir 5-15min se necessário (RENAME 2024)",
    },
]

CATEGORY_LABELS = {
    "antibiotics": "Antibióticos",
    "analgesics": "Analgésicos / Antitérmicos",
    "corticoids": "Corticoides",
    "antiparasitics": "Antiparasitários",
    "antifungals": "Antifúngicos",
    "antihistamines": "Antialérgicos",
    "respiratory": "Respiratório",
    "gastro": "Gastrointestinal",
    "cardio": "Cardiovascular",
    "endocrine": "Endócrino / Metabólico",
    "supplements": "Suplementos",
    "others": "Outros",
}

TEMPLATE_DISPLAY_NAMES = {t.code: t.display_name for t in PrescriptionTemplate}
TEMPLATE_ACTION_CODES = tuple(t.code for t in PrescriptionTemplate)

# ══════════════════════════════════════════════════════════════════
# Dosage Calculation
# ══════════════════════════════════════════════════════════════════


def _format_practical_ml(ml: float) -> str:
    """Round mL to nearest 0.5 (half-up) and strip trailing zeros.

    Pediatric syringes mark 0.5mL increments — fractional values like 7.33mL
    force the parent to round themselves and risk dosing errors. Round at the
    source so the prescription text matches what the syringe shows. The raw
    per_dose_ml field is left intact for any consumer that wants full precision.

    Uses round-half-up rather than Python's banker's rounding: equidistant
    halves go to the larger value (0.25 → 0.5, not 0.0). Conservative for
    clinical dosing — never under-doses at the rounding boundary.
    """
    if ml is None:
        return ""
    rounded = int(float(ml) * 2 + 0.5) / 2
    return f"{rounded:g}"


def _calculate_full_dosages(weight: float) -> list:
    """Calculate all pediatric medication dosages for a given weight."""
    results = []

    for med in PEDIATRIC_MEDICATIONS:
        entry = {
            "id": med["id"],
            "name": med["name"],
            "category": med["category"],
            "frequency": med["frequency"],
            "duration": med["duration"],
            "presentation": med["presentation"],
            "notes": med.get("notes", ""),
            "is_adult": False,
        }
        if "provenance" in med:
            entry["provenance"] = med["provenance"]

        # No-calculation meds (e.g. nasal saline irrigation) — no weight math,
        # just a fixed practical instruction. Mirrors popup _MED_CATALOG_FALLBACK
        # entries that carry no mg/kg rule (CHRA-2048).
        if med.get("no_calc"):
            entry["daily_dose_mg"] = None
            entry["per_dose_mg"] = None
            entry["per_dose_ml"] = None
            entry["per_dose_drops"] = None
            entry["practical"] = med.get("practical_text", "")
            results.append(entry)
            continue

        # Handle weight-based fixed doses (e.g. ondansetron)
        if "weight_based_doses" in med:
            dose_mg = None
            for range_def in med["weight_based_doses"]:
                if range_def["min_kg"] <= weight < range_def["max_kg"]:
                    dose_mg = range_def["dose_mg"]
                    break
            if dose_mg is None:
                dose_mg = med["weight_based_doses"][-1]["dose_mg"]

            unit = med.get("dose_unit", "mg")
            entry["daily_dose_mg"] = round(dose_mg * med["times_per_day"], 1)
            entry["per_dose_mg"] = round(dose_mg, 1)

            # Fixed-dose liquids still need an administrable VOLUME. Mirror the
            # standard branch below: derive mL (and drops) from concentration so
            # the doctor sees e.g. ondansetrona 4mg = 5mL or zinco 20mg = 5mL
            # rather than only the mg dose. Without this, the weight_based_doses
            # liquids (loratadina, desloratadine, ondansetrona, sulfato_zinco)
            # rendered per_dose_ml=None and forced a manual mg->mL conversion at
            # the bedside — exactly the bug-class the sibling Pediatrics repo
            # fixed in d7ba07e (CHRA-1591), never ported here. dose_unit still
            # labels the dose for solid / fixed-unit presentations (benzetacil UI).
            concentration = med.get("concentration")
            if concentration and concentration > 0:
                per_dose_ml = dose_mg / concentration
                entry["per_dose_ml"] = round(per_dose_ml, 2)
                drops_per_ml = med.get("drops_per_ml")
                entry["per_dose_drops"] = (
                    round(per_dose_ml * drops_per_ml) if drops_per_ml else None
                )
            else:
                entry["per_dose_ml"] = None
                entry["per_dose_drops"] = None

            # Practical instruction — same precedence as the standard branch.
            practical_rule = med.get("practical_rule")
            if practical_rule:
                entry["practical"] = f"{practical_rule} ({round(weight)} gotas)"
            elif entry["per_dose_drops"] is not None:
                entry["practical"] = f"{entry['per_dose_drops']} gotas ({_format_practical_ml(entry['per_dose_ml'])}mL)"
            elif entry["per_dose_ml"] is not None:
                entry["practical"] = f"{_format_practical_ml(entry['per_dose_ml'])}mL"
            else:
                entry["practical"] = f"{dose_mg}{unit}"
            results.append(entry)
            continue

        # Standard weight-based calculation
        daily_mg = min(med["dose_per_kg"] * weight, med["max_daily"])
        per_dose_mg = daily_mg / med["times_per_day"]

        # Apply minimum dose if specified (e.g. salbutamol)
        if "min_dose" in med:
            per_dose_mg = max(per_dose_mg, med["min_dose"])
            daily_mg = per_dose_mg * med["times_per_day"]

        entry["daily_dose_mg"] = round(daily_mg, 1)
        entry["per_dose_mg"] = round(per_dose_mg, 1)

        # Calculate mL
        concentration = med.get("concentration")
        if concentration and concentration > 0:
            per_dose_ml = per_dose_mg / concentration
            entry["per_dose_ml"] = round(per_dose_ml, 2)

            # Calculate drops if applicable
            drops_per_ml = med.get("drops_per_ml")
            if drops_per_ml:
                entry["per_dose_drops"] = round(per_dose_ml * drops_per_ml)
            else:
                entry["per_dose_drops"] = None
        else:
            entry["per_dose_ml"] = None
            entry["per_dose_drops"] = None

        # Practical rule
        practical_rule = med.get("practical_rule")
        if practical_rule:
            entry["practical"] = f"{practical_rule} ({round(weight)} gotas)"
        elif entry.get("per_dose_drops") is not None:
            entry["practical"] = f"{entry['per_dose_drops']} gotas ({_format_practical_ml(entry['per_dose_ml'])}mL)"
        elif entry.get("per_dose_ml") is not None:
            entry["practical"] = f"{_format_practical_ml(entry['per_dose_ml'])}mL"
        else:
            unit = med.get("dose_unit", "mg")
            entry["practical"] = f"{entry['per_dose_mg']}{unit}"

        results.append(entry)

    # Backward-compatible aliases for old template IDs that may still be cached
    # in user configs or browser storage from pre-v3.5.0 defaults.
    _alias_map = {
        "paracetamol_ped": "paracetamol",
        "amox_ped": "amox_pneum",
        "ibuprofen_ped": "ibuprofen",
        # Templates 5/6 in the user's stored rx_templates referenced these
        # _ped-suffixed IDs that never existed in the catalog. Without these
        # aliases, _renderSmartTemplate emits "[Medicação X não encontrada]"
        # into the prescription body and the receita opens with placeholder
        # text instead of the prescription.
        "predniso_ped": "prednisolone",
        "cefalexina_ped": "cephalexin",
    }
    for alias_id, canonical_id in _alias_map.items():
        canonical = next((r for r in results if r["id"] == canonical_id), None)
        if canonical and not next((r for r in results if r["id"] == alias_id), None):
            alias_entry = dict(canonical)
            alias_entry["id"] = alias_id
            results.append(alias_entry)

    return results


def _calculate_adult_dosages() -> list:
    """Return adult medication catalog with fixed-dose entries.

    Schema mirrors _calculate_full_dosages() output for frontend uniformity,
    but no weight multiplication: dose fields come straight from the catalog.
    Adds is_adult: True so the frontend can differentiate.
    """
    results = []
    for med in ADULT_MEDICATIONS:
        results.append({
            "id": med["id"],
            "name": med["name"],
            "category": med["category"],
            "frequency": med["frequency"],
            "duration": med["duration"],
            "presentation": med["presentation"],
            "notes": med.get("notes", ""),
            "daily_dose_mg": None,                  # not applicable for adult
            "per_dose_mg": med.get("fixed_dose_mg"),
            "per_dose_ml": None,                    # tablets, no mL
            "per_dose_drops": None,
            "practical": med["fixed_dose_text"],
            "is_adult": True,
        })

    # Backward-compatible aliases for old template IDs.
    _adult_alias_map = {
        "paracetamol_ped": "paracetamol_adult",
        "amox_ped": "amox_adult",
        "ibuprofen_ped": "ibuprofen_adult",
    }
    for alias_id, canonical_id in _adult_alias_map.items():
        canonical = next((r for r in results if r["id"] == canonical_id), None)
        if canonical and not next((r for r in results if r["id"] == alias_id), None):
            alias_entry = dict(canonical)
            alias_entry["id"] = alias_id
            results.append(alias_entry)

    return results


# ══════════════════════════════════════════════════════════════════
# SSE event bus — listeners subscribe here
# ══════════════════════════════════════════════════════════════════

_sse_subscribers: list[queue.Queue] = []
_sse_lock = threading.Lock()


def broadcast_event(event_type: str, data: dict) -> None:
    """Push a server-sent event to all connected dashboard clients."""
    payload = json.dumps({"type": event_type, **data})
    with _sse_lock:
        dead = []
        for q in _sse_subscribers:
            try:
                q.put_nowait(payload)
            except queue.Full:
                dead.append(q)
        for q in dead:
            _sse_subscribers.remove(q)


# ══════════════════════════════════════════════════════════════════
# Pages
# ══════════════════════════════════════════════════════════════════


@bp.route("/")
@require_auth
def index():
    """Main dashboard page.

    CHRA-2403 / CHRA-2394: @require_auth gates the dashboard so the signed
    tfd_sse cookie minted below is only ever issued to an authenticated
    operator. Without this gate an anonymous GET / minted a valid SSE cookie
    that could be replayed against /api/events to read live patient data.
    The SSE endpoint itself keeps @require_sse_auth (cookie path) — NOT
    @require_auth — because the browser EventSource cannot send an
    Authorization header (that is exactly why #97 added the cookie path).
    """
    prescription_templates = list(PrescriptionTemplate)
    template_shortcut_hint = ""
    if prescription_templates:
        template_shortcut_hint = (
            f"{prescription_templates[0].shortcut_key}-"
            f"{prescription_templates[-1].shortcut_key}"
        )

    from flask import make_response
    resp = make_response(
        render_template(
            "index.html",
            prescription_templates=prescription_templates,
            template_shortcut_hint=template_shortcut_hint,
        )
    )
    # Mint the signed SSE cookie so the same-origin EventSource can auth
    # against /api/events (CHRA-2217 / CHRA-2335).
    return mint_sse_cookie(resp)


# ══════════════════════════════════════════════════════════════════
# SSE — real-time event stream
# ══════════════════════════════════════════════════════════════════


@bp.route("/api/events")
@require_sse_auth
def sse_stream():
    """Server-Sent Events endpoint for real-time updates."""
    q: queue.Queue = queue.Queue(maxsize=50)
    with _sse_lock:
        _sse_subscribers.append(q)

    def generate():
        try:
            while True:
                # If this subscriber was dropped (e.g., queue overflow), end the stream
                # so the browser can reconnect and re-subscribe.
                with _sse_lock:
                    if q not in _sse_subscribers:
                        break
                try:
                    data = q.get(timeout=30)
                    yield f"data: {data}\n\n"
                except queue.Empty:
                    yield ": keepalive\n\n"
        except GeneratorExit:
            pass
        finally:
            with _sse_lock:
                if q in _sse_subscribers:
                    _sse_subscribers.remove(q)

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


# ══════════════════════════════════════════════════════════════════
# Status API
# ══════════════════════════════════════════════════════════════════


@bp.route("/api/status")
@require_extension_or_user
def api_status():
    """Get current system status."""
    emr = current_app.config.get("EMR_INSTANCE")

    status = {
        "running": emr is not None,
        "driver_active": False,
        "backend": None,
        "current_patient": None,
        "weight": None,
        "chief_complaint": None,
        "session_valid": False,
        "timestamp": datetime.now().isoformat(),
    }

    if emr:
        # Keep patient context synced with the active chart URL.
        # This enables automatic "new patient" handling (including SOAP clear)
        # as users navigate charts while the dashboard is open.
        try:
            if emr.driver is not None and not getattr(emr, "_session_invalidated", False):
                op_lock = getattr(emr, "_operation_lock", None)
                acquired = False
                try:
                    if op_lock is None:
                        emr.check_and_update_patient_info()
                    else:
                        acquired = op_lock.acquire(blocking=False)
                        if acquired:
                            emr.check_and_update_patient_info()
                finally:
                    if op_lock is not None and acquired:
                        op_lock.release()
        except Exception as sync_error:
            current_app.logger.debug("Status sync skipped: %s", sync_error)

        status["driver_active"] = emr.driver is not None
        status["backend"] = emr._backend
        status["current_patient"] = emr.intern_id
        status["weight"] = emr.weight
        status["chief_complaint"] = emr.chief_complaint
        status["patient_name"] = getattr(emr, "patient_name", None)
        status["patient_age"] = getattr(emr, "patient_age", None)
        status["session_valid"] = not emr._session_invalidated

    return jsonify(status)


# ══════════════════════════════════════════════════════════════════
# Audio API
# ══════════════════════════════════════════════════════════════════


@bp.route("/api/audio/status")
@require_extension_or_user
def api_audio_status():
    """Return current audio capture/transcription status."""
    return jsonify(recorder.status())


@bp.route("/api/audio/start", methods=["POST"])
@require_extension_or_user
def api_audio_start():
    """Start microphone capture in a background thread."""
    result = recorder.start()
    if result.get("error"):
        return jsonify(result), 400
    return jsonify(result)


@bp.route("/api/audio/stop", methods=["POST"])
@require_extension_or_user
def api_audio_stop():
    """Stop recording and run transcription + SOAP summarization."""
    result = recorder.stop()
    if result.get("error"):
        return jsonify(result), 400
    return jsonify(result)


def _insert_text_in_active_emr_field(emr, text: str) -> dict:
    """Insert text into the currently focused editable field in the EMR page."""
    playwright_script = """
        (text) => {
            const resolveActive = (doc) => {
                if (!doc) return null;
                const active = doc.activeElement;
                if (!active) return null;
                if (active.tagName === 'IFRAME') {
                    try {
                        return resolveActive(active.contentDocument);
                    } catch (e) {
                        return null;
                    }
                }
                return active;
            };

            const isEditable = (el) =>
                el &&
                (
                    el.tagName === 'TEXTAREA' ||
                    (el.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit'].includes((el.type || '').toLowerCase())) ||
                    el.isContentEditable
                );

            const appendValue = (el, value) => {
                if (el.isContentEditable) {
                    const base = (el.innerText || '').trim();
                    el.innerText = base ? `${base}\\n${value}` : value;
                    return true;
                }
                if ('value' in el) {
                    const base = (el.value || '').trim();
                    el.value = base ? `${base}\\n${value}` : value;
                    return true;
                }
                return false;
            };

            const target = resolveActive(document);
            if (!target) return { ok: false, error: 'No active element in EMR page' };
            if (!isEditable(target)) return { ok: false, error: 'Focused element is not editable' };

            target.focus();
            const ok = appendValue(target, text);
            if (!ok) return { ok: false, error: 'Failed to insert text into focused field' };

            target.dispatchEvent(new Event('input', { bubbles: true }));
            target.dispatchEvent(new Event('change', { bubbles: true }));
            return { ok: true };
        }
    """

    selenium_script = """
        const text = arguments[0];
        const resolveActive = (doc) => {
            if (!doc) return null;
            const active = doc.activeElement;
            if (!active) return null;
            if (active.tagName === 'IFRAME') {
                try {
                    return resolveActive(active.contentDocument);
                } catch (e) {
                    return null;
                }
            }
            return active;
        };

        const isEditable = (el) =>
            el &&
            (
                el.tagName === 'TEXTAREA' ||
                (el.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit'].includes((el.type || '').toLowerCase())) ||
                el.isContentEditable
            );

        const appendValue = (el, value) => {
            if (el.isContentEditable) {
                const base = (el.innerText || '').trim();
                el.innerText = base ? `${base}\\n${value}` : value;
                return true;
            }
            if ('value' in el) {
                const base = (el.value || '').trim();
                el.value = base ? `${base}\\n${value}` : value;
                return true;
            }
            return false;
        };

        const target = resolveActive(document);
        if (!target) return { ok: false, error: 'No active element in EMR page' };
        if (!isEditable(target)) return { ok: false, error: 'Focused element is not editable' };

        target.focus();
        const ok = appendValue(target, text);
        if (!ok) return { ok: false, error: 'Failed to insert text into focused field' };

        target.dispatchEvent(new Event('input', { bubbles: true }));
        target.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true };
    """

    if getattr(emr, "_backend", None) == "playwright":
        return emr.driver.evaluate(playwright_script, text)
    return emr.driver.execute_script(selenium_script, text)


def _find_dosage_by_id(weight: float, drug_id: str) -> Optional[dict]:
    """Return a calculated dosage entry by its medication ID."""
    for med in _calculate_full_dosages(weight):
        if med["id"] == drug_id:
            return med
    return None


def _format_dosage_export_text(entry: dict) -> str:
    """Format a dosage entry into prescription text suitable for EMR insertion."""
    practical = entry.get("practical") or (
        f"{entry['per_dose_mg']}mg" if entry.get("per_dose_mg") is not None else ""
    )
    notes = (entry.get("notes") or "").strip()
    note_suffix = f" ({notes})" if notes else ""
    return (
        f"{entry['name']}: {practical} VO, {entry['frequency']}, "
        f"por {entry['duration']}.{note_suffix}"
    )


@bp.route("/api/audio/insert", methods=["POST"])
@require_extension_or_user
def api_audio_insert():
    """
    Insert generated SOAP text into the currently focused editable field in EMR.
    """
    data = request.get_json(silent=True) or {}
    note = str(data.get("note", "")).strip()
    if not note:
        return jsonify({"error": "note is required"}), 400

    emr = current_app.config.get("EMR_INSTANCE")
    if not emr or not getattr(emr, "driver", None):
        return jsonify({"error": "EMR not connected"}), 503

    audit = get_audit_logger()
    patient_id = str(data.get("patient_id") or getattr(emr, "intern_id", "")).strip() or None

    try:
        result = _insert_text_in_active_emr_field(emr, note)
    except Exception as exc:
        try:
            audit.log_action(
                action_type="audio_soap_fill",
                patient_id=patient_id,
                template_used="SOAP",
                success=False,
                error_message=str(exc)[:200],
            )
        except Exception:
            pass
        return jsonify({"error": f"Insert failed: {exc}"}), 500

    if not isinstance(result, dict):
        return jsonify({"error": "Unexpected insert result"}), 500
    if not result.get("ok"):
        try:
            audit.log_action(
                action_type="audio_soap_fill",
                patient_id=patient_id,
                template_used="SOAP",
                success=False,
                error_message=result.get("error", "Unable to insert note"),
            )
        except Exception:
            pass
        return jsonify({"error": result.get("error", "Unable to insert note")}), 400
    try:
        audit.log_action(
            action_type="audio_soap_fill",
            patient_id=patient_id,
            template_used="SOAP",
            success=True,
        )
    except Exception:
        pass
    return jsonify({"status": "inserted"})


# ══════════════════════════════════════════════════════════════════
# Patient & Dosage APIs
# ══════════════════════════════════════════════════════════════════


@bp.route("/api/patient")
@require_extension_or_user
def api_patient():
    """Get current patient info and calculated dosages."""
    emr = current_app.config.get("EMR_INSTANCE")
    if not emr:
        return jsonify({"error": "EMR not connected"}), 503

    weight = emr.weight
    complaint = emr.chief_complaint
    intern_id = emr.intern_id
    patient_name = getattr(emr, "patient_name", None)
    patient_age = getattr(emr, "patient_age", None)

    dosages = None
    if weight and weight > 0:
        dosages = _calculate_full_dosages(weight)

    return jsonify({
        "intern_id": intern_id,
        "patient_name": patient_name,
        "patient_age": patient_age,
        "weight": weight,
        "chief_complaint": complaint,
        "dosages": dosages,
    })


@bp.route("/api/dosages")
def api_dosages():
    """Calculate dosages for a given weight (legacy 3-medication format)."""
    weight_str = request.args.get("weight")
    if not weight_str:
        return jsonify({"error": "weight parameter required"}), 400
    try:
        weight = float(weight_str)
        # math.isfinite guards NaN: float("nan") raises no ValueError and every
        # NaN comparison is False, so "weight=nan" would slip past the range check
        # into _calculate_full_dosages → NaN doses on a clinical endpoint.
        if not math.isfinite(weight) or weight <= 0 or weight > 150:
            return jsonify({"error": "weight must be between 0.1 and 150 kg"}), 400
    except ValueError:
        return jsonify({"error": "weight must be a number"}), 400

    # Return legacy 3-medication format for backward compatibility
    concentration = 50
    return jsonify({
        "weight_kg": weight,
        "medications": [
            {
                "name": "Amoxicilina (Faringite)",
                "daily_dose_mg": round(min(50 * weight, 1000)),
                "dose_per_take_mg": round(min(50 * weight, 1000) / 2),
                "dose_ml": round(min(50 * weight, 1000) / 2 / concentration, 1),
                "frequency": "12/12h",
                "duration": "7 dias",
            },
            {
                "name": "Amoxicilina (Pneumonia)",
                "daily_dose_mg": round(min(90 * weight, 4000)),
                "dose_per_take_mg": round(min(90 * weight, 4000) / 2),
                "dose_ml": round(min(90 * weight, 4000) / 2 / concentration, 1),
                "frequency": "12/12h",
                "duration": "7 dias",
            },
            {
                "name": "Cefalexina",
                "daily_dose_mg": round(min(50 * weight, 2000)),
                "dose_per_take_mg": round(min(50 * weight, 2000) / 3),
                "dose_ml": round(min(50 * weight, 2000) / 3 / concentration, 1),
                "frequency": "8/8h",
                "duration": "7 dias",
            },
        ],
    })


@bp.route("/api/dosages/full")
def api_full_dosages():
    """Calculate medication dosages for pediatric and/or adult populations.

    Query params:
        type: "pediatric" (default), "adult", or "both".
        weight: required for pediatric/both; ignored for adult.

    Returns:
        - type=pediatric (default): flat JSON array of pediatric doses.
        - type=adult: flat JSON array of adult fixed-dose entries.
        - type=both: object {"pediatric": [...], "adult": [...]}.
    """
    pop_type = (request.args.get("type") or "pediatric").lower()
    if pop_type not in ("pediatric", "adult", "both"):
        return jsonify({"error": "type must be one of: pediatric, adult, both"}), 400

    needs_weight = pop_type in ("pediatric", "both")
    weight = None
    if needs_weight:
        weight_str = request.args.get("weight")
        if not weight_str:
            # Try to get weight from EMR instance
            emr = current_app.config.get("EMR_INSTANCE")
            if emr and emr.weight:
                weight = emr.weight
            else:
                return jsonify({"error": "weight parameter required"}), 400
        else:
            try:
                weight = float(weight_str)
                # math.isfinite guards NaN (every NaN comparison is False, so it
                # would slip past the range check into NaN doses).
                if not math.isfinite(weight) or weight <= 0 or weight > 150:
                    return jsonify({"error": "weight must be between 0.1 and 150 kg"}), 400
            except ValueError:
                return jsonify({"error": "weight must be a number"}), 400

    if pop_type == "pediatric":
        return jsonify(_calculate_full_dosages(weight))
    if pop_type == "adult":
        return jsonify(_calculate_adult_dosages())
    # both
    return jsonify({
        "pediatric": _calculate_full_dosages(weight),
        "adult": _calculate_adult_dosages(),
    })


@bp.route("/api/dosages/export", methods=["POST"])
def api_dosages_export():
    """Insert a formatted dosage line into the focused EMR field and audit it."""
    data = request.get_json(silent=True) or {}
    drug_id = str(data.get("drug", "")).strip()
    if not drug_id:
        return jsonify({"error": "drug is required"}), 400

    emr = current_app.config.get("EMR_INSTANCE")
    if not emr or not getattr(emr, "driver", None):
        return jsonify({"error": "EMR not connected"}), 503

    weight_raw = data.get("weight")
    if weight_raw in (None, ""):
        weight = getattr(emr, "weight", None)
    else:
        try:
            weight = float(weight_raw)
        except (TypeError, ValueError):
            return jsonify({"error": "weight must be a number"}), 400

    # math.isfinite guards NaN (every NaN comparison is False) — without it
    # "weight=nan" reaches _find_dosage_by_id → _calculate_full_dosages → round(nan)
    # → an unhandled ValueError 500. Mirrors the /api/dosages{,/full} guards (Bug 41);
    # this export route was the third weight-validation site and was missed there.
    if weight is None or not math.isfinite(weight) or weight <= 0 or weight > 150:
        return jsonify({"error": "valid patient weight is required"}), 400

    entry = _find_dosage_by_id(weight, drug_id)
    if not entry:
        return jsonify({"error": f"Unknown drug: {drug_id}"}), 400

    patient_id = str(data.get("patient_id") or getattr(emr, "intern_id", "")).strip() or None
    export_text = _format_dosage_export_text(entry)
    audit = get_audit_logger()
    details = json.dumps(
        {"drug": drug_id, "weight_kg": weight, "text": export_text},
        ensure_ascii=False,
    )

    try:
        result = _insert_text_in_active_emr_field(emr, export_text)
    except Exception as exc:
        try:
            audit.log_action(
                action_type="dosage_export",
                patient_id=patient_id,
                template_used=entry["name"],
                success=False,
                error_message=str(exc)[:200],
                details=details,
            )
        except Exception:
            pass
        return jsonify({"error": f"Dosage export failed: {exc}"}), 500

    if not isinstance(result, dict):
        return jsonify({"error": "Unexpected export result"}), 500
    if not result.get("ok"):
        error = result.get("error", "Unable to insert dosage text")
        try:
            audit.log_action(
                action_type="dosage_export",
                patient_id=patient_id,
                template_used=entry["name"],
                success=False,
                error_message=error,
                details=details,
            )
        except Exception:
            pass
        return jsonify({"error": error}), 400

    try:
        audit.log_action(
            action_type="dosage_export",
            patient_id=patient_id,
            template_used=entry["name"],
            success=True,
            details=details,
        )
    except Exception:
        pass

    return jsonify(
        {
            "status": "inserted",
            "drug": drug_id,
            "patient_id": patient_id,
            "weight_kg": weight,
            "text": export_text,
        }
    )


# ══════════════════════════════════════════════════════════════════
# Actions API — trigger EMR operations
# ══════════════════════════════════════════════════════════════════


@bp.route("/api/actions/<action>", methods=["POST"])
@require_extension_or_user
def api_action(action: str):
    """
    Trigger an EMR automation action.

    Supported actions:
        Any configured prescription template code — Prescription + print only
        discharge — Process discharge (non-blocking)
        medication — Print medication page only
        refresh — Refresh patient data
        complete_workflow — Full workflow (requires JSON body)
    """
    emr = current_app.config.get("EMR_INSTANCE")
    if not emr:
        return jsonify({"error": "EMR not connected"}), 503

    # Sync patient context before reading intern_id to close the race window
    # where the physician navigated to a new patient between poll cycles.
    if getattr(emr, "driver", None) is not None and not getattr(emr, "_session_invalidated", False):
        try:
            emr.check_and_update_patient_info()
        except Exception as _sync_err:
            current_app.logger.debug("api_action pre-sync skipped: %s", _sync_err)

    intern_id = emr.intern_id
    if not intern_id and action not in ("refresh",):
        return jsonify({"error": "No patient selected"}), 400

    # Prevent overlapping workflows against the same browser session.
    op_lock = getattr(emr, "_operation_lock", None)
    if op_lock is not None and not op_lock.acquire(blocking=False):
        return jsonify({"error": "Operacao em andamento. Aguarde concluir."}), 409

    # Read request body before spawning thread (request context won't persist)
    options = {}
    if request.is_json:
        options = request.get_json(silent=True) or {}

    try:
        broadcast_event("action_started", {"action": action, "patient_id": intern_id})
    except Exception as e:
        if op_lock is not None:
            try:
                op_lock.release()
            except RuntimeError:
                pass
        return jsonify({"error": f"Failed to broadcast action start: {e}"}), 500

    def run_action():
        audit = get_audit_logger()
        start = time.time()
        success = False
        error_msg = None
        template_name = None

        try:
            if action == "complete_workflow":
                template_type = options.get("template", "gastro1")
                template_name = TEMPLATE_DISPLAY_NAMES.get(template_type, template_type)

                def on_progress(step: str, steps: list[str]) -> None:
                    try:
                        broadcast_event("workflow_progress", {
                            "patient_id": intern_id,
                            "steps": steps,
                            "current_step": step,
                        })
                    except Exception:
                        pass

                result = emr.complete_workflow(
                    intern_id,
                    template_type,
                    include_medication=options.get("include_medication", False),
                    include_attestation=options.get("include_attestation", False),
                    include_discharge=options.get("include_discharge", True),
                    progress_cb=on_progress,
                )
                success = result.get("overall", False)
                if not success:
                    error_msg = result.get("error", "Workflow failed")
                # Broadcast step-by-step progress
                broadcast_event("workflow_progress", {
                    "patient_id": intern_id,
                    "steps": result.get("steps_completed", []),
                    "overall": success,
                })

            elif action in TEMPLATE_ACTION_CODES:
                template_name = TEMPLATE_DISPLAY_NAMES.get(action, action)
                success = emr.prescribe_and_print(intern_id, action)

            elif action == "discharge":
                success = emr.discharge_and_return(intern_id)

            elif action == "medication":
                success = emr.print_medication_only(intern_id)

            elif action == "refresh":
                emr.extract_patient_weight()
                emr.extract_chief_complaint()
                success = True

            else:
                error_msg = f"Unknown action: {action}"

        except Exception as e:
            error_msg = str(e)[:200]
        finally:
            duration = time.time() - start
            try:
                audit.log_action(
                    action_type=action,
                    patient_id=intern_id,
                    template_used=template_name,
                    success=success,
                    duration_seconds=round(duration, 2),
                    error_message=error_msg,
                )
            except Exception:
                pass
            try:
                broadcast_event("action_completed", {
                    "action": action,
                    "patient_id": intern_id,
                    "success": success,
                    "error": error_msg,
                    "duration": round(duration, 2),
                })
            except Exception:
                pass
            if op_lock is not None:
                try:
                    op_lock.release()
                except RuntimeError:
                    pass

    try:
        threading.Thread(target=run_action, daemon=True).start()
    except Exception as e:
        if op_lock is not None:
            try:
                op_lock.release()
            except RuntimeError:
                pass
        return jsonify({"error": f"Failed to start action: {e}"}), 500
    return jsonify({"status": "started", "action": action, "patient_id": intern_id})


# ══════════════════════════════════════════════════════════════════
# Audit Log API
# ══════════════════════════════════════════════════════════════════


@bp.route("/api/audit")
@require_extension_or_user
def api_audit():
    """Get audit log entries."""
    try:
        audit = get_audit_logger()
        limit = request.args.get("limit", 50, type=int)
        if limit is None or limit < 1:
            limit = 50
        limit = min(limit, MAX_AUDIT_LIMIT)
        patient_id = request.args.get("patient_id")
        action_type = request.args.get("action_type")

        if patient_id:
            entries = audit.get_by_patient(patient_id, limit=limit)
        elif action_type:
            entries = audit.get_by_action(action_type, limit=limit)
        else:
            entries = audit.get_recent(limit=limit)
    except Exception as e:
        return jsonify({"error": f"Audit database unavailable: {e}"}), 503

    return jsonify({"entries": entries, "count": len(entries)})


@bp.route("/api/audit/manual", methods=["POST"])
@require_extension_or_user
def api_audit_manual():
    """Log a manual or extension-sourced action.

    Accepts two formats:
      SW format (service worker):  {action_type, details}
      Dashboard format:            {tags, notes, patient_id}
    """
    data = request.get_json(silent=True) or {}

    # Service-worker format: {action_type: str, details: dict}
    action_type = data.get("action_type")
    if action_type:
        action_type = str(action_type).strip()[:50]
        details_raw = data.get("details") or {}
        if not isinstance(details_raw, dict):
            details_raw = {}
        template_used = str(details_raw.get("diagnosis") or "").strip()[:200] or None
        try:
            audit = get_audit_logger()
            row_id = audit.log_action(
                action_type=action_type,
                template_used=template_used,
                details=json.dumps(details_raw, ensure_ascii=False)[:2000],
            )
        except Exception as e:
            return jsonify({"error": f"Audit database unavailable: {e}"}), 503
        return jsonify({"status": "logged", "id": row_id})

    # Dashboard format: {tags, notes, patient_id}
    tags_raw = data.get("tags", [])
    if tags_raw is None:
        tags_raw = []
    if not isinstance(tags_raw, list):
        return jsonify({"error": "tags must be a list"}), 400

    tags = [str(t).strip() for t in tags_raw if str(t).strip()]
    notes = str(data.get("notes") or "").strip()
    patient_id = str(data.get("patient_id") or "").strip() or None

    if not tags and not notes:
        return jsonify({"error": "tags or notes are required"}), 400

    try:
        audit = get_audit_logger()
        row_id = audit.log_manual_action(
            patient_id=patient_id,
            action_tags=tags,
            notes=notes[:2000],
        )
    except Exception as e:
        return jsonify({"error": f"Audit database unavailable: {e}"}), 503
    return jsonify({"status": "logged", "id": row_id})


@bp.route("/api/error-log", methods=["POST"])
@require_extension_or_user
def api_error_log():
    """Client-side error telemetry. Stores structured errors from the extension.

    Lightweight Sentry alternative. Schema:
      where (str): code location, e.g. 'hud.processDischarge'
      error_message (str): err.message, truncated to 500 chars
      stack (str): err.stack, truncated to 2000 chars
      context (dict): non-PII metadata (no patient names, CPF, SOAP content)
      user_id (int): authenticated user id if available
      ext_version (str): extension manifest version
      user_agent (str): navigator.userAgent

    LGPD note: this endpoint must never store patient data. Extension client
    is responsible for scrubbing. Server-side, we log to Flask's rotating
    file log and (TODO) a dedicated errors table in Postgres.
    """
    data = request.get_json(silent=True) or {}
    where = str(data.get("where", "unknown"))[:120]
    err = str(data.get("error_message", ""))[:500]
    stack = str(data.get("stack", ""))[:2000]
    ctx = data.get("context") or {}
    ver = str(data.get("ext_version", "?"))[:20]
    uid = data.get("user_id")
    ua = str(data.get("user_agent", ""))[:300]
    ts = str(data.get("ts", ""))[:40]
    import json, logging
    ext_logger = logging.getLogger("pedbot.extension_error")
    ext_logger.warning(
        "[ext-error] v=%s uid=%s where=%s | %s | ctx=%s | ua=%s | ts=%s",
        ver, uid, where, err, json.dumps(ctx)[:300], ua[:80], ts,
    )
    if stack:
        ext_logger.warning("[ext-error-stack] %s", stack.replace("\n", " | ")[:500])
    return jsonify({"ok": True})


# Lazy module-level setup for the extension-debug logger. Built once on first
# /api/debug-log call and reused thereafter. Writes to a dedicated rotating
# file at backend/logs/extension-debug.log so the dev can `tail -f` it
# remotely on the Mac Mini without grepping through the main Flask log.
_ext_debug_logger: Optional[logging.Logger] = None


def _get_ext_debug_logger() -> logging.Logger:
    global _ext_debug_logger
    if _ext_debug_logger is not None:
        return _ext_debug_logger
    from logging.handlers import RotatingFileHandler
    log_dir = Path(__file__).resolve().parent.parent.parent / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / "extension-debug.log"
    lg = logging.getLogger("pedbot.extension_debug")
    lg.setLevel(logging.DEBUG)
    # Idempotent: only attach the handler once even if the function is
    # racey-called from concurrent requests before the global is set.
    if not any(isinstance(h, RotatingFileHandler) and getattr(h, "baseFilename", "") == str(log_path) for h in lg.handlers):
        handler = RotatingFileHandler(str(log_path), maxBytes=10 * 1024 * 1024, backupCount=3)
        handler.setFormatter(logging.Formatter("%(asctime)s %(message)s"))
        lg.addHandler(handler)
    _ext_debug_logger = lg
    return lg


@bp.route("/api/debug-log", methods=["POST"])
@require_extension_or_user
def api_debug_log():
    """Generic debug-log sink for intercepted console.warn / console.error
    calls from the extension.

    Schema (best-effort — every field is optional, defaulted server-side):
      level (str): 'warn' | 'error' | 'info'
      message (str): the joined console arg payload, truncated to 4000 chars
                     by the client; server caps at 4500 as a safety net
      source (str): 'sidepanel' | 'popup' | 'content-script' | 'extension-page'
      ts (str): ISO timestamp from the client clock
      ext_version (str): extension manifest version
      url (str): location.href at the moment of the call (truncated 400 chars)

    Visibility: developer-only. The doctor never sees this; the dev tails
    the resulting backend/logs/extension-debug.log file remotely on the Mac
    Mini. This is the deliberate choice — debug logs are for the developer
    and the doctor should not be burdened with a UI toggle.

    LGPD note: payloads MAY include patient names (e.g., when the
    extractCompanionInfo diagnostic dumps an outerHTML snippet). Acceptable
    here because the log file lives only on the doctor's own Mac Mini, on
    their home network, and is never shipped to a third party. If this
    endpoint were ever exposed to a multi-tenant deployment, the client-side
    shipper would need a redaction pass.
    """
    data = request.get_json(silent=True) or {}
    level = str(data.get("level", "info"))[:10]
    message = str(data.get("message", ""))[:4500]
    src = str(data.get("source", "?"))[:30]
    ver = str(data.get("ext_version", "?"))[:20]
    url = str(data.get("url", ""))[:400]
    ts = str(data.get("ts", ""))[:40]
    lg = _get_ext_debug_logger()
    lg.info(
        "[%s] [%s] [v=%s] [%s] %s | url=%s",
        level.upper(), src, ver, ts, message, url[:120],
    )
    return jsonify({"ok": True})


@bp.route("/api/audit/summary")
@require_extension_or_user
def api_audit_summary():
    """Get audit summary statistics."""
    days = request.args.get("days", 7, type=int)
    if days is None or days < 1:
        days = 7
    days = min(days, MAX_AUDIT_EXPORT_DAYS)
    try:
        audit = get_audit_logger()
        return jsonify(audit.get_summary(days=days))
    except Exception as e:
        return jsonify({"error": f"Audit database unavailable: {e}"}), 503


@bp.route("/api/rx-stats")
@require_extension_or_user
def api_rx_stats():
    """Prescription template usage ranked by selection AND print count.

    Returns all-time counts grouped by template_used, joining two action types:
      - prescription_select: HUD template button clicks (intent, hud.js)
      - prescription_printed: every print-button click on any rx dialog
                              (completion, dom-engine.js print tracker)

    Each row in `ranking` carries both `selects` and `prints` so the caller
    can sort either metric or compute abandonment (selects without prints).

    Optional ?days=N filters to the trailing N days. ?action=select|print
    filters the merged ranking to one source if a single-metric view is wanted.
    """
    days = request.args.get("days", type=int)
    action_filter = (request.args.get("action") or "").strip().lower()

    try:
        audit = get_audit_logger()
        with audit._connect() as conn:
            params: tuple = ()
            time_clause = ""
            if days and days > 0:
                cutoff = (datetime.now() - timedelta(days=days)).isoformat()
                time_clause = " AND timestamp >= ?"
                params = (cutoff,)

            def _fetch(action_type: str):
                sql = (
                    "SELECT template_used, COUNT(*) AS uses, MAX(timestamp) AS last_used "
                    "FROM audit_log "
                    "WHERE action_type = ? AND template_used IS NOT NULL AND TRIM(template_used) != ''"
                    + time_clause +
                    " GROUP BY template_used ORDER BY uses DESC"
                )
                return conn.execute(sql, (action_type, *params)).fetchall()

            select_rows = _fetch("prescription_select")
            print_rows = _fetch("prescription_printed")

        # Merge both action types into a unified ranking keyed by template_used.
        merged: dict[str, dict] = {}
        for r in select_rows:
            name = r["template_used"]
            merged[name] = {
                "name": name,
                "selects": r["uses"],
                "prints": 0,
                "last_select": r["last_used"],
                "last_print": None,
            }
        for r in print_rows:
            name = r["template_used"]
            entry = merged.setdefault(name, {
                "name": name,
                "selects": 0,
                "prints": 0,
                "last_select": None,
                "last_print": None,
            })
            entry["prints"] = r["uses"]
            entry["last_print"] = r["last_used"]

        # Default sort: prints DESC (completion), then selects DESC (intent).
        # When action filter is set, sort by that single metric.
        if action_filter == "select":
            sort_key = lambda x: (-x["selects"], -x["prints"])
            merged = {k: v for k, v in merged.items() if v["selects"] > 0}
        elif action_filter == "print":
            sort_key = lambda x: (-x["prints"], -x["selects"])
            merged = {k: v for k, v in merged.items() if v["prints"] > 0}
        else:
            sort_key = lambda x: (-x["prints"], -x["selects"])

        ranking_sorted = sorted(merged.values(), key=sort_key)
        ranking = [{"rank": i + 1, **row} for i, row in enumerate(ranking_sorted)]

        return jsonify({
            "ranking": ranking,
            "totals": {
                "selects": sum(r["selects"] for r in ranking),
                "prints": sum(r["prints"] for r in ranking),
                "templates": len(ranking),
            },
        })
    except Exception as e:
        return jsonify({"error": f"Audit database unavailable: {e}"}), 503


@bp.route("/api/audit/export", methods=["POST"])
@require_extension_or_user
def api_audit_export():
    """Export audit data as a JSON download streamed directly to the browser."""
    days = request.json.get("days", 30) if request.is_json else 30
    try:
        days = int(days)
    except Exception:
        days = 30
    if days < 1:
        days = 30
    days = min(days, MAX_AUDIT_EXPORT_DAYS)
    try:
        audit = get_audit_logger()
        since = (datetime.now() - timedelta(days=days)).isoformat()

        def _fetch():
            from emr_automation.audit_log import AuditLogger  # local to avoid polluting module scope
            with audit._connect() as conn:
                return conn.execute(
                    "SELECT * FROM audit_log WHERE timestamp >= ? ORDER BY id",
                    (since,),
                ).fetchall()

        rows = audit._run_with_retry(_fetch)
        data = {
            "exported_at": datetime.now().isoformat(),
            "period_days": days,
            "total_records": len(rows),
            "records": [dict(r) for r in rows],
        }
        payload = json.dumps(data, indent=2, ensure_ascii=False, default=str).encode("utf-8")
        buf = io.BytesIO(payload)
        filename = f"audit_export_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
        return send_file(
            buf,
            mimetype="application/json",
            as_attachment=True,
            download_name=filename,
        )
    except Exception as e:
        return jsonify({"error": f"Audit export failed: {e}"}), 503


# ══════════════════════════════════════════════════════════════════
# Configuration API
# ══════════════════════════════════════════════════════════════════


@bp.route("/api/config", methods=["GET"])
@require_extension_or_user
def api_config_get():
    """Read current configuration. Auth-gated (CHRA-2080 / CSO follow-up):
    even with passwords masked, this exposes the configured EMR username,
    OAuth client IDs, and which secrets are populated — reconnaissance
    useful to anyone who reaches the dashboard port. Matches the auth
    posture of the patient-data routes hardened in CHRA-2136."""
    config_path = current_app.config["CONFIG_PATH"]
    config = configparser.ConfigParser()

    # Start with defaults so the UI isn't empty when config.ini is missing.
    result: dict = {
        section: {k: str(v) for k, v in options.items()}
        for section, options in DEFAULT_CONFIG.items()
    }

    # Overlay saved config.ini values (if present)
    if Path(config_path).exists():
        config.read(config_path)
        for section in config.sections():
            if section not in result:
                result[section] = {}
            for key, value in config.items(section):
                result[section][key] = value

    # Mask secrets
    for section, options in result.items():
        if not isinstance(options, dict):
            continue
        for key, value in list(options.items()):
            if key in ("password", "oauth_access_token", "oauth_client_secret"):
                options[key] = "***" if value else ""

    # Include available templates
    templates = []
    for t in PrescriptionTemplate:
        templates.append({
            "code": t.code,
            "display_name": t.display_name,
            "checkbox_id": t.checkbox_id,
            "shortcut_key": t.shortcut_key,
        })
    result["_templates"] = templates

    return jsonify(result)


@bp.route("/api/config", methods=["POST"])
@require_extension_or_user
def api_config_save():
    """Update configuration and save to config.ini. Auth-gated: a writable
    config endpoint with no allowlist on section names lets an attacker
    overwrite EMR credentials, model selection, or auth gates. Matches the
    auth posture of the patient-data routes hardened in CHRA-2136."""
    config_path = current_app.config["CONFIG_PATH"]
    updates = request.get_json(silent=True)
    if not updates:
        return jsonify({"error": "No data provided"}), 400

    config = configparser.ConfigParser()
    # Seed with defaults so a missing config.ini still results in a complete file.
    for section, options in DEFAULT_CONFIG.items():
        if not config.has_section(section):
            config.add_section(section)
        for key, value in options.items():
            config.set(section, key, str(value))

    if Path(config_path).exists():
        config.read(config_path)

    errors = []

    for section, options in updates.items():
        if section.startswith("_"):
            continue
        if not isinstance(options, dict):
            continue

        if not config.has_section(section):
            config.add_section(section)

        for key, value in options.items():
            if value == "***":
                continue

            if key in ("headless", "disable_ssl_verify", "use_playwright"):
                val = str(value).strip().lower()
                truthy = {"true", "1", "yes", "on"}
                falsy = {"false", "0", "no", "off"}
                if val not in truthy and val not in falsy:
                    errors.append(f"{section}.{key} must be a boolean (true/false)")
                    continue
                value = "True" if val in truthy else "False"

            if key in ("timeout", "manual_login_timeout", "max_retries"):
                try:
                    int(value)
                except (ValueError, TypeError):
                    errors.append(f"{section}.{key} must be an integer")
                    continue

            if key in (
                "amoxicillin_strep_dose", "amoxicillin_strep_max",
                "amoxicillin_pneumonia_dose", "amoxicillin_pneumonia_max",
                "cephalexin_dose", "cephalexin_max", "concentration",
                "retry_delay",
            ):
                try:
                    float(value)
                except (ValueError, TypeError):
                    errors.append(f"{section}.{key} must be a number")
                    continue

            if key == "base_url" and value:
                if not (value.startswith("http://") or value.startswith("https://")):
                    errors.append(f"{section}.{key} must start with http:// or https://")
                    continue

            config.set(section, key, str(value))

    if errors:
        return jsonify({"errors": errors}), 400

    tmp_path = None
    try:
        with _config_write_lock:
            config_dir = Path(config_path).parent
            with tempfile.NamedTemporaryFile(
                mode="w", dir=str(config_dir), suffix=".tmp", delete=False
            ) as tmp:
                config.write(tmp)
                tmp_path = tmp.name
            os.replace(tmp_path, config_path)
    except Exception as e:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except Exception:
                pass
        return jsonify({"error": f"Failed to save config: {e}"}), 500

    emr = current_app.config.get("EMR_INSTANCE")
    if emr:
        try:
            emr.config.read(config_path)
        except Exception:
            pass

    broadcast_event("config_updated", {"timestamp": datetime.now().isoformat()})
    return jsonify({"status": "saved"})


# ══════════════════════════════════════════════════════════════════
# Per-user clinical config (phase 003)
# ══════════════════════════════════════════════════════════════════
# Holds prescription templates, SOAP voices, custom instructions, doctor name,
# and behavioral toggles. One row per Clerk-authenticated user. Replaces the
# legacy chrome.storage.sync.prescriptionTemplates path so doctors carry their
# library across devices and shared hospital Chrome profiles.


def _serialize_user_config(cfg):
    """Shape the UserConfig row for JSON. Mirrors PATCH input shape."""
    return {
        "rx_templates": cfg.rx_templates or [],
        "voices": cfg.voices or [],
        "active_voice_id": cfg.active_voice_id or "voice_padrao",
        "custom_instructions": cfg.custom_instructions or "",
        "doctor_name": cfg.doctor_name or "",
        "auto_cid": bool(cfg.auto_cid),
        "auto_clear_soap": bool(cfg.auto_clear_soap),
        "auto_fill_companion": bool(cfg.auto_fill_companion),
        "auto_prefill_encaminh": bool(cfg.auto_prefill_encaminh),
        "auto_transcribe_on_dictation": bool(cfg.auto_transcribe_on_dictation),
        "updated_at": cfg.updated_at.isoformat() if cfg.updated_at else None,
    }


def _get_or_seed_user_config(session, user_id):
    """Return the user's config row, creating + seeding defaults if absent."""
    from sqlalchemy.exc import IntegrityError

    cfg = session.query(UserConfig).filter_by(user_id=user_id).first()
    if cfg is None:
        cfg = UserConfig(
            user_id=user_id,
            rx_templates=json.loads(json.dumps(DEFAULT_RX_TEMPLATES)),
            voices=[],
            active_voice_id="voice_padrao",
            custom_instructions="",
            doctor_name="",
            auto_cid=True,
            auto_clear_soap=True,
            auto_fill_companion=True,
            auto_prefill_encaminh=True,
            auto_transcribe_on_dictation=False,
        )
        session.add(cfg)
        try:
            session.commit()
        except IntegrityError:
            # Bug 75 (Bug 73/74 family): /api/me/config GET+PATCH both seed via this
            # SELECT-then-INSERT, and the extension fires the userConfig hydrate
            # concurrently on sign-in. user_id is the UserConfig PRIMARY KEY, so a
            # concurrent first-access for the same new user already inserted the row.
            # get_session() is a thread-local scoped_session — leaving it in a
            # PendingRollback state here would 500 the caller's next query. Roll back
            # and adopt the winner's row.
            session.rollback()
            cfg = session.query(UserConfig).filter_by(user_id=user_id).first()
            if cfg is None:
                raise
    return cfg


@bp.route("/api/me/config", methods=["GET"])
@require_auth
def api_me_config_get():
    """Return the authenticated user's clinical config.

    Lazy-seeds DEFAULT_RX_TEMPLATES on first access for a new user.
    """
    from emr_automation.database import get_session
    session = get_session()
    cfg = _get_or_seed_user_config(session, g.user_id)
    return jsonify(_serialize_user_config(cfg))


@bp.route("/api/me/config", methods=["PATCH"])
@require_auth
def api_me_config_patch():
    """Partial-update the authenticated user's clinical config.

    Accepts any subset of: rx_templates (list), voices (list),
    custom_instructions (str), doctor_name (str), auto_cid /
    auto_clear_soap / auto_transcribe_on_dictation (bool).

    Last-writer-wins by updated_at. No optimistic-concurrency check —
    clinical config is single-author per user.
    """
    from emr_automation.database import get_session
    session = get_session()
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "JSON object body required"}), 400

    cfg = _get_or_seed_user_config(session, g.user_id)

    if "rx_templates" in data:
        if not isinstance(data["rx_templates"], list):
            return jsonify({"error": "rx_templates must be an array"}), 400
        cfg.rx_templates = data["rx_templates"]

    if "voices" in data:
        if not isinstance(data["voices"], list):
            return jsonify({"error": "voices must be an array"}), 400
        cfg.voices = data["voices"]

    if "custom_instructions" in data:
        cfg.custom_instructions = str(data["custom_instructions"])[:5000]

    if "doctor_name" in data:
        cfg.doctor_name = str(data["doctor_name"])[:255]

    if "active_voice_id" in data:
        cfg.active_voice_id = str(data["active_voice_id"])[:64]

    for k in (
        "auto_cid",
        "auto_clear_soap",
        "auto_fill_companion",
        "auto_prefill_encaminh",
        "auto_transcribe_on_dictation",
    ):
        if k in data:
            setattr(cfg, k, bool(data[k]))

    cfg.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
    session.commit()
    return jsonify(_serialize_user_config(cfg))


# ══════════════════════════════════════════════════════════════════
# Billing (Stripe) — spec-compliant /api/* endpoints (NEXT_STEPS.md §5)
# Legacy /billing/* routes live in routes_billing.py; these are the
# launch-spec paths the extension calls. Helpers in billing.py.
# ══════════════════════════════════════════════════════════════════


@bp.route("/api/billing/checkout", methods=["POST"])
@require_auth
def api_billing_checkout():
    """Create a Stripe Checkout session for the authenticated user.

    Body: {"plan": "pro"|"hospital", "success_url"?: str, "cancel_url"?: str}
    """
    data = request.get_json(silent=True) or {}
    plan = data.get("plan", "pro")
    success_url = data.get("success_url", "https://api.tocafichadr.com.br/billing/success")
    cancel_url = data.get("cancel_url", "https://api.tocafichadr.com.br/billing/cancel")
    result = create_checkout_session(g.user_id, plan, success_url, cancel_url)
    if isinstance(result, dict) and "error" in result:
        return jsonify(result), 400
    return jsonify(result)


@bp.route("/api/billing/portal", methods=["POST"])
@require_auth
def api_billing_portal():
    """Create a Stripe Billing Portal session so the user can manage/cancel.

    Body: {"return_url"?: str}
    """
    data = request.get_json(silent=True) or {}
    return_url = data.get("return_url", "https://api.tocafichadr.com.br/")
    result = create_portal_session(g.user_id, return_url)
    if isinstance(result, dict) and "error" in result:
        return jsonify(result), 400
    return jsonify(result)


@bp.route("/api/stripe-webhook", methods=["POST"])
def api_stripe_webhook():
    """Receive Stripe webhook events (unauthenticated; verified by signature).

    Signature is checked inside handle_webhook against the webhook secret.
    """
    sig = request.headers.get("Stripe-Signature", "")
    result = handle_webhook(request.data, sig)
    if isinstance(result, tuple):
        body, status = result
        return jsonify(body), status
    return jsonify(result)


@bp.route("/api/me/usage", methods=["GET"])
@require_auth
def api_me_usage():
    """Return the authenticated user's plan, trial, subscription, and usage."""
    result = get_subscription(g.user_id)
    if isinstance(result, dict) and "error" in result:
        return jsonify(result), 404
    return jsonify(result)


# ══════════════════════════════════════════════════════════════════
# Health check
# ══════════════════════════════════════════════════════════════════


@bp.route("/api/health")
def api_health():
    """Health check endpoint for Work Launcher or Docker."""
    return jsonify({"status": "ok", "timestamp": datetime.now().isoformat()})


@bp.route("/config/api-url.json", methods=["GET"])
def config_api_url():
    """Discovery endpoint so the Chrome extension can locate the first-party API."""
    payload = jsonify({
        "apiBaseUrl": "https://api.tocafichadr.com.br",
        "schemaVersion": 1,
    })
    payload.headers["Cache-Control"] = "public, max-age=300"
    return payload


# Extension IDs allowed to receive the externally_connectable AUTH_COMPLETED
# ping. Mirrors the Clerk `allowed_origins` allowlist set at the instance
# level (see 2026-05-13 session log). New extension IDs must be added BOTH
# here and at Clerk dashboard → Instance → Allowed Origins.
_AUTH_SUCCESS_ALLOWED_EXT_IDS = frozenset({
    "dldnbfjpobloegmdockjpbmpmgaahgan",  # path-derived dev ID (current)
    "ijmooblmcfkgocpjjcaipimgeofpammn",  # future deterministic via manifest.key
})


@bp.route("/api/auth/success")
def api_auth_success():
    """Friendly post-Clerk-signin landing page that auto-closes its tab.

    Clerk's server-side validator rejects chrome-extension:// redirect URLs
    (invalid_url_scheme, verified 2026-05-10), so the post-signin landing
    must live on an HTTPS origin. This page replaces the raw /api/health
    JSON the extension used to redirect to. It:

    1. Shows a "Login concluído" confirmation card (no raw JSON).
    2. Calls chrome.runtime.sendMessage(EXT_ID, {type: AUTH_COMPLETED}) so
       the extension's SW (via the externally_connectable manifest entry)
       fires the side-panel reload immediately — no 30s storage-poll wait.
    3. Auto-closes the tab via window.close() after 1.2s.

    ext_id is passed by the extension in the redirectUrl query param and
    validated against an allowlist. Unknown IDs skip the sendMessage step
    silently — the page still renders + auto-closes for the user.
    """
    raw_ext_id = (request.args.get("ext_id", "") or "").strip()
    # Only embed the ext_id in JS if it's in the allowlist — defense against
    # a hypothetical actor crafting a URL to ping arbitrary extension IDs.
    safe_ext_id = raw_ext_id if raw_ext_id in _AUTH_SUCCESS_ALLOWED_EXT_IDS else ""

    html = """<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Login concluído — Toca Ficha Dr.</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      min-height: 100vh; background: #0d0d0d; color: #ddd;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      display: flex; align-items: center; justify-content: center; padding: 24px;
    }
    .card {
      max-width: 420px; background: #111; border: 1px solid #1f1f1f;
      border-radius: 12px; padding: 32px 28px; text-align: center;
    }
    .check {
      width: 56px; height: 56px; margin: 0 auto 16px; border-radius: 50%;
      background: rgba(16, 185, 129, 0.12); color: #10b981;
      display: flex; align-items: center; justify-content: center;
      font-size: 28px; font-weight: 700;
    }
    h1 { font-size: 18px; color: #fff; margin-bottom: 8px; font-weight: 600; }
    p { font-size: 13px; color: #888; line-height: 1.5; margin-bottom: 18px; }
    #hint { font-size: 11px; color: #555; }
  </style>
</head>
<body>
  <div class="card">
    <div class="check">✓</div>
    <h1>Login concluído</h1>
    <p>Você já pode voltar à extensão. Esta aba fechará sozinha.</p>
    <p id="hint">&nbsp;</p>
  </div>
  <script>
  (function () {
    var EXT_ID = __EXT_ID__;
    // Notify the extension SW via externally_connectable. The SW handler
    // (chrome.runtime.onMessageExternal) re-broadcasts AUTH_COMPLETED so
    // the side panel reloads to the logged-in view immediately.
    if (EXT_ID && typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
      try {
        chrome.runtime.sendMessage(EXT_ID, { type: "TOCAFICHADR_AUTH_COMPLETED" }, function () {});
      } catch (e) { /* extension not installed or sendMessage unavailable — fall through */ }
    }
    setTimeout(function () { try { window.close(); } catch (e) {} }, 1200);
    setTimeout(function () {
      var h = document.getElementById("hint");
      if (h) h.textContent = "Se a aba não fechar, feche-a manualmente.";
    }, 2500);
  })();
  </script>
</body>
</html>"""
    # Embed the validated ext_id as a JS string literal. Using json.dumps
    # ensures correct escaping even if the allowlist grows to IDs with
    # unusual characters (currently they're all [a-p]{32} per Chrome's
    # extension-ID alphabet, but defense in depth costs nothing).
    html = html.replace("__EXT_ID__", json.dumps(safe_ext_id))
    return Response(html, mimetype="text/html; charset=utf-8")


@bp.route("/api/readiness")
def api_readiness():
    """Config readiness check for production auth/cost-sensitive startup gates."""
    auth_required = os.environ.get("TOCAFICHADR_AUTH_REQUIRED", "").strip().lower() in (
        "true",
        "1",
        "yes",
    )

    def has_secret(env_name: str, keychain_service: str) -> bool:
        if os.environ.get(env_name):
            return True
        try:
            keychain_secret(keychain_service)
            return True
        except SystemExit:
            return False

    db_ok = True
    db_error = None
    try:
        from emr_automation.database import get_engine

        with get_engine().connect() as conn:
            conn.exec_driver_sql("SELECT 1")
    except Exception as exc:  # noqa: BLE001 - readiness should surface all DB errors
        db_ok = False
        # Log the full exception server-side; return only the class name to
        # the client. /api/readiness is intentionally public (ops probe);
        # str(exc) can include hostname, schema names, and credential
        # format hints that turn a public probe into a recon endpoint.
        current_app.logger.error("readiness: DB probe failed: %s", exc, exc_info=True)
        db_error = type(exc).__name__

    cors_origins = [item.strip() for item in os.environ.get("CORS_ORIGINS", "*").split(",")]
    authorized_parties = _authorized_parties()

    checks = {
        "database": {"ok": db_ok, "error": db_error},
        "openai": {"ok": has_openai_oauth_config()},
        "clerk_secret": {"ok": has_secret("CLERK_SECRET_KEY", "pedbot-clerk-secret-key")},
        "clerk_authorized_parties": {"ok": bool(authorized_parties), "count": len(authorized_parties)},
        "stripe_secret": {"ok": has_secret("STRIPE_SECRET_KEY", "pedbot-stripe-secret-key")},
        "auth_required": {"ok": auth_required, "value": auth_required},
        "cors_origins": {"ok": "*" not in cors_origins, "count": len([c for c in cors_origins if c])},
    }

    required_when_auth_on = ("database", "clerk_secret", "clerk_authorized_parties", "cors_origins")
    required_always = ("database", "openai")
    ok = all(checks[name]["ok"] for name in required_always)
    if auth_required:
        ok = ok and all(checks[name]["ok"] for name in required_when_auth_on)

    return jsonify({
        "status": "ready" if ok else "not_ready",
        "checks": checks,
    }), 200 if ok else 503


# ══════════════════════════════════════════════════════════════════
# Chrome Extension API endpoints
# ══════════════════════════════════════════════════════════════════

from emr_automation.extension_api import (
    transcribe_audio,
    suggest_cid,
    format_soap,
    format_soap_stream,
    format_atestado_letter,
    _postprocess_soap,
    get_soap_provider_metadata,
)
from emr_automation.selector_config import load_selectors
from emr_automation.idempotency import idempotent


# Singleton OpenAI client — avoids per-request TCP/TLS handshake overhead.
# build_openai_client() creates a new httpx-backed OpenAI() instance each time,
# which forces a fresh TLS negotiation to api.openai.com on every API call.
# Caching the client reuses the connection pool across requests.
_openai_client_cache = None

def _get_openai_client():
    """Resolve an OpenAI client from config or environment (cached singleton)."""
    global _openai_client_cache
    if _openai_client_cache is not None:
        return _openai_client_cache
    app_config = current_app.config.get("CONFIG_PATH")
    cfg = None
    if app_config:
        cfg = configparser.ConfigParser()
        cfg.read(app_config)
    _openai_client_cache = build_openai_client(cfg)
    return _openai_client_cache


_AUDIO_METADATA_ALLOWED = {
    "mimeType",
    "audioBitsPerSecond",
    "requestedBitsPerSecond",
}
_AUDIO_TRACK_SETTINGS_ALLOWED = {
    "sampleRate",
    "sampleSize",
    "channelCount",
    "latency",
    "echoCancellation",
    "noiseSuppression",
    "autoGainControl",
}


def _parse_audio_metadata(raw: str | None) -> dict:
    """Parse browser audio telemetry without storing device identifiers."""
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        return {}
    if not isinstance(parsed, dict):
        return {}

    sanitized = {k: parsed.get(k) for k in _AUDIO_METADATA_ALLOWED if k in parsed}
    settings = parsed.get("trackSettings")
    if isinstance(settings, dict):
        sanitized["trackSettings"] = {
            k: settings.get(k)
            for k in _AUDIO_TRACK_SETTINGS_ALLOWED
            if k in settings
        }
    return {k: v for k, v in sanitized.items() if v is not None}


def _log_model_observability(action_type: str, result: dict) -> None:
    """Write provider/timing observability to audit without PHI-bearing text."""
    if not isinstance(result, dict):
        return
    details = {
        "providers": result.get("providers") or {},
        "timing": result.get("timing") or {},
        "audio": result.get("audio") or {},
    }
    if not details["providers"] and not details["timing"] and not details["audio"]:
        return
    try:
        audit = get_audit_logger()
        audit.log_action(
            action_type=action_type[:50],
            details=json.dumps(details, ensure_ascii=False)[:2000],
        )
    except Exception:
        logger.exception("model observability audit failed for action_type=%s", action_type)


@bp.route("/api/selectors")
def api_selectors():
    """Serve DOM selector config for an EMR."""
    emr = request.args.get("emr", "ghosp")
    config = load_selectors(emr)
    if config is None:
        return jsonify({"error": f"No config for EMR: {emr}"}), 404
    return jsonify(config)


@bp.route("/api/transcribe", methods=["POST"])
@require_extension_or_user
@idempotent("transcribe")
def api_transcribe():
    """Transcribe audio and return SOAP + CID suggestion."""
    guard = _billable_request_guard()
    if guard is not None:
        return guard

    if "audio" not in request.files:
        return jsonify({"error": "No audio file provided"}), 400

    audio_file = request.files["audio"]
    audio_bytes = audio_file.read()

    if len(audio_bytes) < 100:
        return jsonify({"error": "Audio file too small"}), 400
    if len(audio_bytes) > _MAX_AUDIO_BYTES:
        return jsonify({
            "error": "Audio file too large",
            "code": "UPLOAD_TOO_LARGE",
            "max_bytes": _MAX_AUDIO_BYTES,
        }), 413
    audio_metadata = _parse_audio_metadata(request.form.get("audio_metadata"))

    client = _get_openai_client()
    if client is None:
        return jsonify({"error": "OpenAI OAuth not configured"}), 400

    # v3.1 idea #8: SOAP voice may arrive as a JSON string in multipart form.
    # transcribe_audio doesn't take a voice today; the voice is most useful on
    # the *streaming* path (idea #3). For backwards compat we accept the field
    # here but ignore it inside transcribe_audio — extensions that want voice
    # control should call POST /api/soap-stream after transcription completes.
    voice_raw = request.form.get("soap_voice")
    if voice_raw:
        try:
            json.loads(voice_raw)  # validate only; not yet plumbed through transcribe_audio
        except (ValueError, TypeError):
            pass

    # v3.1.1 streaming path: extension side panel passes ?skip_soap=1 to defer
    # SOAP generation to /api/soap-stream. Saves ~1.6-3.2s on this response;
    # the caller then opens an SSE Port for incremental SOAP rendering.
    skip_soap_arg = request.args.get("skip_soap", "")
    skip_soap = skip_soap_arg in ("1", "true", "yes")

    result = transcribe_audio(
        audio_bytes=audio_bytes,
        mime_type=audio_file.content_type or "audio/webm",
        chief_complaint=request.form.get("chief_complaint", ""),
        client=client,
        custom_instructions=request.form.get("custom_instructions", ""),
        skip_soap=skip_soap,
        audio_metadata=audio_metadata,
    )

    if _is_billable_success(result):
        _log_billable_usage("transcribe")
    _log_model_observability("transcribe_observability", result)

    status_code = result.pop("status_code", None)
    if status_code:
        return jsonify(result), status_code
    return jsonify(result)


@bp.route("/api/suggest-cid", methods=["POST"])
@require_extension_or_user
@idempotent("suggest-cid")
def api_suggest_cid():
    """Suggest CID-10 code from SOAP text."""
    guard = _billable_request_guard()
    if guard is not None:
        return guard

    data = request.get_json()
    if not data or "soap_text" not in data:
        return jsonify({"error": "soap_text required"}), 400

    client = _get_openai_client()
    if client is None:
        return jsonify({"error": "OpenAI OAuth not configured"}), 400

    result = suggest_cid(
        soap_text=data["soap_text"],
        chief_complaint=data.get("complaint", ""),
        client=client,
    )
    if _is_billable_success(result):
        _log_billable_usage("suggest_cid")
    _log_model_observability("suggest_cid_observability", result)
    try:
        audit.log_action(
            action_type="cid_suggested",
            details=json.dumps({
                "code": result.get("cid_code"),
                "confidence": result.get("confidence"),
                "name": result.get("cid_name"),
            }, ensure_ascii=False),
            success=True,
        )
    except Exception:
        pass  # audit must not break the response
    return jsonify(result)


@bp.route("/api/format-soap", methods=["POST"])
@require_extension_or_user
@idempotent("format-soap")
def api_format_soap():
    """Format raw text as SOAP note."""
    guard = _billable_request_guard()
    if guard is not None:
        return guard

    data = request.get_json()
    if not data or "raw_text" not in data:
        return jsonify({"error": "raw_text required"}), 400

    client = _get_openai_client()
    if client is None:
        return jsonify({"error": "OpenAI OAuth not configured"}), 400

    result = format_soap(
        raw_text=data["raw_text"],
        chief_complaint=data.get("complaint", ""),
        client=client,
        custom_instructions=data.get("custom_instructions", ""),
        soap_voice=data.get("soap_voice"),
    )
    if _is_billable_success(result):
        _log_billable_usage("format_soap")
    _log_model_observability("format_soap_observability", result)
    return jsonify(result)


# Atestado letter-mode: drafts a pediatric guidance letter (carta) given
# patient context + the doctor's intent. Used by the chrome extension's
# atestado letter-mode UI. The LLM amplifies doctor_intent into formal
# Brazilian-Portuguese prose; per the system prompt rules it must NOT add
# clinical claims beyond what was provided.
@bp.route("/api/format-atestado-letter", methods=["POST"])
@require_extension_or_user
@idempotent("format-atestado-letter")
def api_format_atestado_letter():
    """Draft a pediatric guidance letter (atestado em formato de carta)."""
    guard = _billable_request_guard()
    if guard is not None:
        return guard

    data = request.get_json(silent=True)
    if not data:
        return jsonify({"error": "JSON body required"}), 400

    doctor_intent = str(data.get("doctor_intent") or "").strip()
    if not doctor_intent:
        return jsonify({"error": "doctor_intent required"}), 400

    client = _get_openai_client()
    if client is None:
        return jsonify({"error": "OpenAI OAuth not configured"}), 400

    result = format_atestado_letter(
        patient_name=str(data.get("patient_name") or ""),
        patient_age=str(data.get("patient_age") or ""),
        diagnosis_text=str(data.get("diagnosis_text") or ""),
        doctor_intent=doctor_intent,
        client=client,
    )
    if _is_billable_success(result):
        _log_billable_usage("format_atestado_letter")
    _log_model_observability("atestado_observability", result)
    return jsonify(result)


# v3.1 idea #3: Streaming SOAP endpoint — SSE.
#
# The extension service worker opens a long-lived chrome.runtime.Port,
# which proxies a POST here and forwards each `data:` frame as a SOAP_TOKEN
# message back to the content script. Doctor sees tokens stream into the
# SOAP textarea instead of waiting 1.5-3s for the whole response.
#
# Request body (JSON):
#   { "raw_text": "...", "chief_complaint": "...",
#     "custom_instructions": "...", "soap_voice": {...|null} }
#
# Response: text/event-stream
#   data: {"t": "..."}\n\n   ... data: [DONE]\n\n
#
# On error: data: {"error": "..."}\n\n followed by stream end.
@bp.route("/api/soap-stream", methods=["POST"])
@require_extension_or_user
def api_soap_stream():
    """Stream SOAP tokens as Server-Sent Events."""
    guard = _billable_request_guard()
    if guard is not None:
        return guard

    data = request.get_json(silent=True) or {}
    if "raw_text" not in data:
        return jsonify({"error": "raw_text required"}), 400

    client = _get_openai_client()
    if client is None:
        return jsonify({"error": "OpenAI OAuth not configured"}), 400

    raw_text       = data.get("raw_text", "")
    custom_instr   = data.get("custom_instructions", "")
    soap_voice     = data.get("soap_voice")  # may be None

    user_id = g.user_id

    def generate():
        # Accumulate deltas so we can post-process the assembled SOAP at the
        # end. The model emits [OBJETIVO_PLACEHOLDER] literally per SOAP_TEMPLATE;
        # _postprocess_soap substitutes it with the canonical ~250-word OBJETIVO
        # block, normalizes voice, and canonicalizes the PLANO footer. Without
        # this post-process step the streaming client pastes the raw placeholder
        # into G-Hosp (regression, v3.1.1).
        accumulated = []
        stream_start = time.perf_counter()
        first_token_s = None
        token_count = 0
        final_payload = {}
        try:
            for delta in format_soap_stream(
                raw_text=raw_text,
                client=client,
                custom_instructions=custom_instr,
                soap_voice=soap_voice,
            ):
                if first_token_s is None:
                    first_token_s = round(time.perf_counter() - stream_start, 3)
                token_count += 1
                accumulated.append(delta)
                # SSE frames must end with \n\n. JSON-encode token to handle
                # newlines/quotes/unicode safely.
                yield f"data: {json.dumps({'t': delta}, ensure_ascii=False)}\n\n"
            # Final frame carries the canonical post-processed SOAP. The SW
            # Port handler prefers this over the buffered tokens when assembling
            # the SOAP_DONE payload. Old SW versions (no `final` parsing) fall
            # back to the buffered tokens — degraded but not broken.
            final_soap = _postprocess_soap("".join(accumulated))
            total_s = round(time.perf_counter() - stream_start, 3)
            final_payload = {
                "final": final_soap,
                "providers": {"soap": get_soap_provider_metadata(stream=True)},
                "timing": {
                    "soap_first_token_s": first_token_s,
                    "soap_total_s": total_s,
                    "token_chunks": token_count,
                    "total_s": total_s,
                },
            }
            yield f"data: {json.dumps(final_payload, ensure_ascii=False)}\n\n"
            # Log usage + observability BEFORE the [DONE] frame. The SW aborts the
            # fetch the instant it receives [DONE] (port.disconnect() →
            # port.onDisconnect → aborter.abort() in service-worker.src.js),
            # closing the connection before this generator can resume — so any
            # statement after the [DONE] yield is unreachable on the happy path.
            # Pre-fix the success-path model observability was never logged and the
            # Phase-B audit row was never written. (Same mechanism as Pediatrics
            # a3ee672, where it was also a free-tier bypass; here soap_stream is
            # non-billable per Bug 38, so the impact is lost observability/audit,
            # not a daily-limit bypass.)
            if user_id is not None:
                try:
                    log_usage(user_id, "soap_stream")
                except Exception:
                    pass
            _log_model_observability("soap_stream_observability", final_payload)
            yield "data: [DONE]\n\n"
        except Exception as exc:  # noqa: BLE001 — surface any provider error to client
            elapsed = round(time.perf_counter() - stream_start, 3)
            error_payload = {
                "error": str(exc),
                "providers": {"soap": get_soap_provider_metadata(stream=True)},
                "timing": {
                    "soap_first_token_s": first_token_s,
                    "soap_total_s": elapsed,
                    "token_chunks": token_count,
                    "total_s": elapsed,
                },
            }
            _log_model_observability("soap_stream_observability", error_payload)
            yield f"data: {json.dumps(error_payload, ensure_ascii=False)}\n\n"
            return

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # disable nginx/Cloudflare buffering
            "Connection": "keep-alive",
        },
    )
