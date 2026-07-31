from __future__ import annotations

from .scan import scan_all
from .state import load_state, filter_candidates
from .rank import rank


def triage_and_pick(cfg, cwd, ranker=None, baseline_red: bool = False):
    """scan → filter (State/Quarantäne) → rank. Gibt einen Pick oder None."""
    # Quellen und Issue-Repo kommen aus der Config: der Web-Lauf darf keine
    # tsc/lint-Kandidaten anbieten (sein Gate baut nur) und muss seine Issues
    # im eigenen Repo suchen.
    candidates = scan_all(cwd, sources=cfg.scan_sources, github_repo=cfg.github_repo)
    state = load_state(cfg.triage_state_path)
    fresh = filter_candidates(state, candidates)
    if not fresh:
        return None
    if ranker is None:
        return rank(fresh, baseline_red=baseline_red)
    return rank(fresh, baseline_red=baseline_red, ranker=ranker)
