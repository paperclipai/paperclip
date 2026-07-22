from __future__ import annotations

from .scan import scan_all
from .state import load_state, filter_candidates
from .rank import rank


def triage_and_pick(cfg, cwd, ranker=None, baseline_red: bool = False):
    """scan → filter (State/Quarantäne) → rank. Gibt einen Pick oder None."""
    candidates = scan_all(cwd)
    state = load_state(cfg.triage_state_path)
    fresh = filter_candidates(state, candidates)
    if not fresh:
        return None
    if ranker is None:
        return rank(fresh, baseline_red=baseline_red)
    return rank(fresh, baseline_red=baseline_red, ranker=ranker)
