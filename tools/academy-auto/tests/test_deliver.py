from types import SimpleNamespace
from academy_auto.pending import PendingRecord
from academy_auto.deliver import deliver, build_reply_markup


def _cfg(mode="daily"):
    # github_repo kennzeichnet im Digest, welcher Lauf gemeint ist — seit es
    # zwei gibt (Lern-App und Marketing-Site) landen beide im selben Chat.
    return SimpleNamespace(pending_path="p", notify_mode=mode, milestone_delta_threshold=50,
                           github_repo="whitestagai/ki-kompass")


def _deps(rec, sent):
    return SimpleNamespace(
        read_pending=lambda p: rec,
        send=lambda text, markup: sent.append((text, markup)),
    )


def test_no_pending():
    assert deliver(_cfg(), _deps(None, [])) == "no_pending"


def test_daily_sends_even_nothing():
    rec = PendingRecord("t", "nothing_to_do", "", "", "", "", False, 0, [])
    sent = []
    assert deliver(_cfg("daily"), _deps(rec, sent)) == "sent"
    assert sent and sent[0][1] is None  # keine Buttons ohne Change


def test_milestone_skips_nothing():
    rec = PendingRecord("t", "nothing_to_do", "", "", "", "", False, 0, [])
    sent = []
    assert deliver(_cfg("milestone"), _deps(rec, sent)) == "skipped"
    assert not sent


def test_change_gets_buttons():
    rec = PendingRecord("2026-07-25T02:00:03", "committed", "T", "", "n", "s",
                        True, 646, [])
    sent = []
    assert deliver(_cfg("daily"), _deps(rec, sent)) == "sent"
    text, markup = sent[0]
    assert markup["inline_keyboard"][0][0]["callback_data"] == "academy:approve:2026-07-25T02:00:03"


def test_build_reply_markup_shape():
    m = build_reply_markup("R")
    labels = [b["text"] for row in m["inline_keyboard"] for b in row]
    assert "✅ PR öffnen" in labels and "❌ Verwerfen" in labels
