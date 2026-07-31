from pathlib import Path
from academy_auto.config import Config


def test_default_config_has_expected_invariants():
    cfg = Config.default()
    assert cfg.branch == "agents/academy-auto"
    assert cfg.max_tasks_per_run == 1
    assert cfg.max_diff_lines == 800
    assert cfg.pause_flag.name == "academy-auto.pause"
    assert cfg.dry_run_flag.name == "academy-auto.dryrun"
    assert cfg.worktree_path.name == "worktree"
    # Gate: genau die drei nicht-mutierenden Checks, in Reihenfolge
    assert cfg.gate_commands == [
        ["npm", "test"],
        ["npx", "tsc", "--noEmit"],
        ["npm", "run", "lint"],
    ]
    # Academy-Quelle liegt bewusst außerhalb von CloudStorage (launchd-Zugriff)
    assert cfg.academy_repo.name == "WHITESTAG.ACADEMY"
    assert isinstance(cfg.denied_globs, tuple)
    assert cfg.triage_state_path.name == "triage-state.json"
    assert isinstance(cfg.secret_read_paths, tuple)


def test_default_has_communication_fields():
    from academy_auto.config import Config
    cfg = Config.default()
    assert cfg.notify_mode == "daily"
    assert cfg.pending_path.name == "pending.json"
    assert cfg.intent_path.name == "intent.json"
    assert cfg.milestone_delta_threshold == 50
    assert cfg.github_repo == "whitestagai/ki-kompass"
    # unter der bestehenden State-Basis ~/.paperclip/academy-auto/
    assert cfg.pending_path.parent == cfg.triage_state_path.parent
