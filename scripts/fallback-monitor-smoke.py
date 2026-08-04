#!/usr/bin/env python3
"""Offline smoke tests for fallback-monitor.py."""
from __future__ import annotations

import importlib.util
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


HERE = Path(__file__).resolve().parent
MONITOR_PATH = HERE / "fallback-monitor.py"


def load_monitor_module() -> Any:
    spec = importlib.util.spec_from_file_location("fallback_monitor", MONITOR_PATH)
    if not spec or not spec.loader:
        raise RuntimeError(f"unable to load {MONITOR_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def assert_eq(actual: Any, expected: Any, label: str) -> None:
    if actual != expected:
        raise AssertionError(f"{label}: expected {expected!r}, got {actual!r}")


def gemini_quota_detection_matches_real_string() -> None:
    monitor = load_monitor_module()
    run = {"id": "run-1", "error": ""}
    monitor.fetch_run_log_text = (
        lambda _base, _key, _run_id: "Individual quota reached. Please upgrade your "
        "subscription to increase your limits. Resets in 75h57m58s."
    )

    match, provider_hint, source = monitor.detect_limit(run, "base", "key")

    assert_eq(bool(match), True, "gemini quota detected")
    assert_eq(provider_hint, "gemini", "provider hint")
    assert_eq("Individual quota reached" in source, True, "source preserved")


def gemini_quota_reset_prefers_relative_hint() -> None:
    monitor = load_monitor_module()
    anchor = datetime(2026, 7, 1, 0, 0, 0, tzinfo=timezone.utc)
    reset_at = monitor.parse_reset_at(
        "Individual quota reached. Please upgrade your subscription to increase "
        "your limits. Resets in 75h57m58s.",
        "usage",
        anchor,
        "gemini",
    )
    assert_eq(
        reset_at.isoformat().replace("+00:00", "Z"),
        "2026-07-04T03:57:58Z",
        "precise reset window",
    )


def generic_rate_limit_is_not_misclassified_as_gemini_quota() -> None:
    monitor = load_monitor_module()
    match, provider_hint = monitor.detect_limit_text("HTTP 429 rate limit exceeded")
    assert_eq(match, None, "bare 429 ignored")
    assert_eq(provider_hint, None, "no provider hint for bare 429")


def grok_weekly_quota_detection_matches_real_string() -> None:
    monitor = load_monitor_module()
    run = {"id": "run-grok-1", "error": ""}
    monitor.fetch_run_log_text = (
        lambda _base, _key, _run_id: "xAI Grok weekly quota reached for grok-4-fast. "
        "Resets in 6d11h30m."
    )

    match, provider_hint, source = monitor.detect_limit(run, "base", "key")

    assert_eq(bool(match), True, "grok quota detected")
    assert_eq(provider_hint, "grok", "grok provider hint")
    assert_eq("weekly quota reached" in source.lower(), True, "grok source preserved")


def grok_weekly_quota_reset_prefers_relative_hint() -> None:
    monitor = load_monitor_module()
    anchor = datetime(2026, 7, 1, 0, 0, 0, tzinfo=timezone.utc)
    reset_at = monitor.parse_reset_at(
        "xAI Grok weekly quota reached for grok-4-fast. Resets in 6d11h30m.",
        "weekly",
        anchor,
        "grok",
    )
    assert_eq(
        reset_at.isoformat().replace("+00:00", "Z"),
        "2026-07-07T11:30:00Z",
        "grok weekly reset window",
    )


def grok_render_lanes_stay_excluded() -> None:
    monitor = load_monitor_module()
    assert_eq(
        monitor.agent_is_render_only_grok_lane(
            {"name": "Designer-Media", "title": "Designer / Media (grok-imagine)"}
        ),
        True,
        "designer-media excluded",
    )
    assert_eq(
        monitor.agent_is_render_only_grok_lane(
            {"name": "Engineer-Hermes", "title": "Software Engineer (Hermes bulk lane)"}
        ),
        False,
        "text hermes lane allowed",
    )
    assert_eq(
        monitor.agent_is_video_render_grok_lane(
            {"name": "Designer-Media", "title": "Designer / Media video clips (grok-imagine-video)"}
        ),
        True,
        "video render lane stays excluded",
    )
    assert_eq(
        monitor.agent_is_video_render_grok_lane(
            {"name": "Engineer-Hermes", "title": "Software Engineer (Hermes bulk lane)"}
        ),
        False,
        "text lane is not misclassified as video render",
    )


def grok_quota_state_excludes_all_render_lanes() -> None:
    monitor = load_monitor_module()
    monitor.load_grok_quota_state = lambda *_args, **_kwargs: {
        "status": "exhausted",
        "updated": "2026-07-24T12:34:06",
    }
    monitor.fetch_agent = lambda _base, _key, agent_id: {
        "primary-text": {
            "id": "primary-text",
            "name": "Engineer-Hermes",
            "title": "Software Engineer (Hermes bulk lane)",
            "adapterType": "hermes_local",
            "status": "idle",
        },
        "primary-render": {
            "id": "primary-render",
            "name": "Designer-Media",
            "title": "Designer / Media (grok-imagine)",
            "adapterType": "hermes_local",
            "status": "idle",
        },
        "primary-video": {
            "id": "primary-video",
            "name": "Designer-Media",
            "title": "Designer / Media video clips (grok-imagine-video)",
            "adapterType": "hermes_local",
            "status": "idle",
        },
        "sister-codex": {
            "id": "sister-codex",
            "name": "Engineer-Codex",
            "adapterType": "codex_local",
            "status": "idle",
        },
        "sister-hermes": {
            "id": "sister-hermes",
            "name": "Engineer-Hermes-2",
            "adapterType": "hermes_local",
            "status": "idle",
        },
    }.get(agent_id)
    monitor.list_open_issues = lambda _base, _key, _company_id, assignee_id: (
        [{"id": "issue-1", "identifier": "QUEUE-1"}]
        if assignee_id == "primary-text"
        else [{"id": "issue-2", "identifier": "RENDER-1"}]
        if assignee_id == "primary-render"
        else [{"id": "issue-3", "identifier": "VIDEO-1"}]
    )
    monitor.issue_has_active_run = lambda *_args, **_kwargs: False

    swaps = monitor.scan_grok_quota_exhausted_primaries(
        "base",
        "key",
        "company-1",
        {
            "primary-text": ["sister-hermes", "sister-codex"],
            "primary-render": ["sister-codex"],
            "primary-video": ["sister-codex"],
        },
        set(),
        "/tmp",
        True,
    )

    assert_eq(len(swaps), 1, "only text primaries are considered")
    assert_eq(swaps[0]["primary"], "primary-text", "text primary selected")
    assert_eq(swaps[0]["availableSisters"], ["sister-codex"], "grok-backed sister skipped")
    assert_eq(swaps[0]["wouldMove"], ["QUEUE-1"], "text queue preview preserved")


def grok_quota_state_keeps_picture_render_excluded() -> None:
    monitor = load_monitor_module()
    monitor.load_grok_quota_state = lambda *_args, **_kwargs: {
        "status": "exhausted",
        "updated": "2026-07-24T12:34:06",
    }
    monitor.fetch_agent = lambda _base, _key, agent_id: {
        "primary-render": {
            "id": "primary-render",
            "name": "Designer-Media",
            "title": "Designer / Media (grok-imagine)",
            "adapterType": "hermes_local",
            "status": "idle",
        },
        "sister-codex": {
            "id": "sister-codex",
            "name": "Engineer-Codex",
            "adapterType": "codex_local",
            "status": "idle",
        },
    }.get(agent_id)
    monitor.list_open_issues = lambda *_args, **_kwargs: [{"id": "issue-2", "identifier": "RENDER-1"}]
    monitor.issue_has_active_run = lambda *_args, **_kwargs: False

    swaps = monitor.scan_grok_quota_exhausted_primaries(
        "base",
        "key",
        "company-1",
        {"primary-render": ["sister-codex"]},
        set(),
        "/tmp",
        True,
    )

    assert_eq(swaps, [], "picture render lane never reassigns on grok exhaustion")


def manually_parked_executive_is_not_a_paused_primary() -> None:
    """Regression for TSMC-19292 / TSK-6600.

    The fallback monitor must not mistake a deliberately parked CEO sister for
    a failed primary merely because the role and pause reason use display text
    instead of the old exact ``ceo`` / ``manual`` spellings.
    """
    monitor = load_monitor_module()
    assert_eq(
        monitor.is_paused_by_design_primary(
            {
                "role": "Chief Executive Officer",
                "pauseReason": "manual — active Codex CEO is the elected lane",
            },
            ["available-sister"],
        ),
        True,
        "manual executive pause is ignored",
    )


def third_party_monitor_requests_sister_self_takeover_without_calling_route() -> None:
    """Regression for TSMC-19292: monitors may wake, never impersonate sisters."""
    monitor = load_monitor_module()
    calls: list[tuple[str, str, dict[str, Any] | None]] = []

    def fake_api(base: str, key: str, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        calls.append((method, path, body))
        return {"id": "comment-1"}

    monitor.api = fake_api
    ok, reason = monitor.request_sister_self_takeover(
        "base", "key", "issue-1", "sister-1", "usage", datetime(2026, 8, 4, tzinfo=timezone.utc), False
    )

    assert_eq(ok, True, "self-takeover request succeeds")
    assert_eq(reason, None, "self-takeover request has no error")
    assert_eq(
        calls,
        [
            (
                "POST",
                "/api/issues/issue-1/comments",
                {
                    "body": "Fallback monitor: detected a fallback-eligible primary and selected "
                    "registered sister @agent://sister-1 until `2026-08-04T00:00:00Z`.\n\n"
                    "The monitor does not reassign on the sister's behalf. The selected sister "
                    "must self-take over this issue through `POST /api/issues/:issueId/"
                    "fallback-reassign` with its own agent identity and the matching limit reason."
                },
            )
        ],
        "monitor posts the sister wake request",
    )
    assert_eq(
        any(path.endswith("/fallback-reassign") for _method, path, _body in calls),
        False,
        "monitor never calls the sister-only reassignment route",
    )
    assert_eq(
        monitor.is_paused_by_design_primary(
            {"role": "Chief Executive Officer", "pauseReason": "budget"},
            ["available-sister"],
        ),
        False,
        "budget executive pause remains recoverable",
    )
    assert_eq(
        monitor.is_paused_by_design_primary(
            {"role": "Software Engineer", "pauseReason": "manual"},
            ["available-sister"],
        ),
        False,
        "manual engineer pause remains recoverable",
    )


def main() -> int:
    gemini_quota_detection_matches_real_string()
    gemini_quota_reset_prefers_relative_hint()
    generic_rate_limit_is_not_misclassified_as_gemini_quota()
    grok_weekly_quota_detection_matches_real_string()
    grok_weekly_quota_reset_prefers_relative_hint()
    grok_render_lanes_stay_excluded()
    grok_quota_state_excludes_all_render_lanes()
    grok_quota_state_keeps_picture_render_excluded()
    manually_parked_executive_is_not_a_paused_primary()
    third_party_monitor_requests_sister_self_takeover_without_calling_route()
    print("OK: fallback-monitor smoke tests passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
