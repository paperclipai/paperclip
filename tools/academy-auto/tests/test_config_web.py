from academy_auto.config import Config, TARGETS


def test_default_is_the_academy_target():
    """`Config.default()` bleibt der ki-kompass-Lauf — alles Bestehende haengt daran."""
    assert Config.default() == Config.for_target("academy")


def test_web_target_points_at_the_astro_repo():
    cfg = Config.for_target("web")
    assert cfg.academy_repo.name == "whitestag-academy-web"
    assert cfg.github_repo == "whitestagai/whitestag-academy-web"


def test_web_gate_is_the_astro_build():
    """Die Site hat keine Tests und kein eslint — der Build ist der Beweis."""
    assert Config.for_target("web").gate_commands == [["npm", "run", "build"]]


def test_web_scan_sources_match_the_gate():
    """Kern der Lehre vom 31.07.: der Scanner darf nur Arbeit anbieten, die das
    Gate auch messen kann. Das Web-Gate baut nur — tsc/lint-Kandidaten waeren
    unmessbar und liefen in dieselbe 'kein Fortschritt'-Sackgasse."""
    web = Config.for_target("web")
    assert "tsc" not in web.scan_sources
    assert "lint" not in web.scan_sources
    assert "issue" in web.scan_sources          # Walters Steuerhebel bleibt
    academy = Config.for_target("academy")
    assert "tsc" in academy.scan_sources and "lint" in academy.scan_sources


def test_targets_never_share_state_or_worktree():
    """Zwei Laeufe, die sich Worktree, pending.json oder Flags teilen, wuerden
    sich gegenseitig ueberschreiben."""
    a, w = Config.for_target("academy"), Config.for_target("web")
    for field in ("worktree_path", "pending_path", "triage_state_path",
                  "intent_path", "pause_flag", "dry_run_flag", "academy_repo"):
        assert getattr(a, field) != getattr(w, field), field


def test_web_auto_merge_covers_the_page_sources():
    """Seiten, Komponenten, Layouts und Styles liegen alle unter src/."""
    assert Config.for_target("web").auto_merge_path_prefixes == ("src/",)


def test_all_targets_are_constructible():
    for name in TARGETS:
        assert Config.for_target(name).branch
