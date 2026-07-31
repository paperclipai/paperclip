from __future__ import annotations


def config_for_intent(intent, configs, read_pending):
    """Welcher Lauf ist gemeint?

    Der Bot kennt genau EINEN `intent.json`-Pfad — die Telegram-Callback-Daten
    tragen kein Ziel. Zugeordnet wird deshalb über `ref_run_ts`: jeder Lauf
    schreibt seine eigene `pending.json` mit einem eindeutigen Zeitstempel.
    Passt keiner, gibt es None zurück und der Aufrufer meldet "überholt",
    statt auf gut Glück im falschen Repo einen PR zu öffnen.

    Freitext-Richtungen haben keine run_ts und gehen an den ersten (Haupt-)Lauf.
    """
    if intent.kind == "direction":
        return configs[0] if configs else None
    for cfg in configs:
        rec = read_pending(cfg.pending_path)
        if rec is not None and rec.run_ts == intent.ref_run_ts:
            return cfg
    return None


def process_intent(cfg, deps) -> str:
    """Verarbeitet genau eine Intent-Datei. Fail-soft, idempotent (löscht am Ende)."""
    intent = deps.read_intent(cfg.intent_path)
    if intent is None:
        return "none"

    # Freigabe/Verwerfen nur auf den passenden Nachtstand (ref_run_ts).
    if intent.kind in ("approve", "reject"):
        rec = deps.read_pending(cfg.pending_path)
        if rec is None or rec.run_ts != intent.ref_run_ts:
            deps.notify("Dieser Vorschlag ist überholt — keine Aktion.")
            deps.clear_intent(cfg.intent_path)
            return "stale"

    result = "none"
    try:
        if intent.kind == "approve":
            url = deps.open_pr(cfg)
            deps.notify(f"✅ PR geöffnet: {url}")
            result = "approved"
        elif intent.kind == "reject":
            deps.reset_branch(cfg)
            deps.notify("❌ Verworfen — Branch zurückgesetzt.")
            result = "rejected"
        elif intent.kind == "direction":
            num = deps.create_issue(cfg, intent.text)
            deps.notify(f"✍️ Als Nachtaufgabe notiert (Issue #{num}).")
            result = "direction"
    except Exception as exc:  # fail-soft: Fehler melden, Intent bleibt NICHT stehen
        detail = (getattr(exc, "stderr", "") or "").strip()
        deps.notify(f"⚠️ Konnte Aktion nicht ausführen: {exc}" + (f"\n{detail}" if detail else ""))
    deps.clear_intent(cfg.intent_path)
    return result


def _pr_create_argv(cfg):
    """Reines argv-Bauen für `gh pr create` — --head MUSS der gepushte
    Branch (cfg.branch, z.B. "agents/academy-auto") sein, nicht nur der
    letzte Pfad-Teil, sonst findet gh den Head-Branch nicht."""
    return ["gh", "pr", "create", "--repo", cfg.github_repo,
            "--head", cfg.branch, "--base", cfg.base_branch, "--fill"]


def _open_pr_default(cfg):  # pragma: no cover - echter gh-Aufruf beim Deploy
    import subprocess
    wt = str(cfg.worktree_path)
    subprocess.run(["git", "-C", wt, "push", "-f", "origin", cfg.branch], check=True)
    # cwd=wt ist Pflicht: `gh pr create --fill` liest Titel/Body aus dem
    # lokalen Git-Log; ohne cwd läuft gh im Deploy-Ordner (kein .git) -> Fehler.
    proc = subprocess.run(
        _pr_create_argv(cfg),
        cwd=wt, capture_output=True, text=True, check=True,
    )
    return proc.stdout.strip()


def _reset_branch_default(cfg):  # pragma: no cover
    import subprocess
    wt = str(cfg.worktree_path)
    subprocess.run(["git", "-C", wt, "reset", "--hard", cfg.base_branch], check=False)
    subprocess.run(["git", "-C", wt, "clean", "-fd"], check=False)


def _create_issue_default(cfg, text):  # pragma: no cover
    import subprocess
    proc = subprocess.run(
        ["gh", "issue", "create", "--repo", cfg.github_repo,
         "--title", text[:70], "--body", f"Von Walter via Jarvis: {text}"],
        capture_output=True, text=True, check=True,
    )
    url = proc.stdout.strip()
    return int(url.rstrip("/").split("/")[-1])


def main() -> None:  # pragma: no cover - vom Bot per Subprozess angestoßen
    from types import SimpleNamespace
    from .config import Config, TARGETS
    from . import intent as intent_mod, pending, notify
    # Alle Läufe teilen sich denselben intent.json-Pfad (der Bot kennt nur
    # einen). Der Standard-Lauf legt ihn fest; zugeordnet wird über run_ts.
    configs = [Config.for_target(t) for t in TARGETS]
    shared_intent = configs[0].intent_path
    parsed = intent_mod.read_intent(shared_intent)
    cfg = configs[0]
    if parsed is not None:
        cfg = config_for_intent(parsed, configs, pending.read_pending) or configs[0]
    # Der gewählte Lauf muss den geteilten intent-Pfad lesen, nicht seinen eigenen.
    cfg = type(cfg)(**{**cfg.__dict__, "intent_path": shared_intent})
    deps = SimpleNamespace(
        read_intent=intent_mod.read_intent,
        read_pending=pending.read_pending,
        clear_intent=intent_mod.clear_intent,
        open_pr=_open_pr_default,
        reset_branch=_reset_branch_default,
        create_issue=_create_issue_default,
        notify=lambda text: notify.send_digest(text),
    )
    print(process_intent(cfg, deps))


if __name__ == "__main__":  # pragma: no cover
    main()
