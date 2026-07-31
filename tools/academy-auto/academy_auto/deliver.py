from __future__ import annotations

from .milestone import is_milestone
from .report import build_digest_from_pending


def build_reply_markup(run_ts: str) -> dict:
    return {"inline_keyboard": [[
        {"text": "✅ PR öffnen", "callback_data": f"academy:approve:{run_ts}"},
        {"text": "❌ Verwerfen", "callback_data": f"academy:reject:{run_ts}"},
    ]]}


def deliver(cfg, deps) -> str:
    """Liest pending.json, entscheidet nach notify_mode, sendet Digest (+Buttons)."""
    rec = deps.read_pending(cfg.pending_path)
    if rec is None:
        return "no_pending"
    if cfg.notify_mode == "milestone" and not is_milestone(rec, cfg.milestone_delta_threshold):
        return "skipped"
    text = build_digest_from_pending(rec)
    markup = build_reply_markup(rec.run_ts) if rec.has_change else None
    ok = deps.send(text, markup)
    # send gibt True/False zurück; None (Alt-Fakes) als Erfolg werten
    return "sent" if ok or ok is None else "send_failed"


def main() -> None:  # pragma: no cover - CLI/launchd
    from types import SimpleNamespace
    from .config import Config
    from . import pending, notify
    cfg = Config.default()
    deps = SimpleNamespace(
        read_pending=pending.read_pending,
        send=lambda text, markup: notify.send_digest(text, reply_markup=markup),
    )
    print(deliver(cfg, deps))


if __name__ == "__main__":  # pragma: no cover
    main()
