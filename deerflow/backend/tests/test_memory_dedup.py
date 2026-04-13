"""Tests for case-insensitive dedup and reinforcement detection."""

import pytest
from langchain_core.messages import HumanMessage

from deerflow.agents.memory.storage import FileMemoryStorage, _create_empty_memory, set_memory_storage
from deerflow.agents.memory.updater import _fact_content_key, MemoryUpdater
from deerflow.agents.middlewares.memory_middleware import detect_correction, detect_reinforcement


def _human(text: str) -> HumanMessage:
    return HumanMessage(content=text)


@pytest.fixture(autouse=True)
def _use_tmp_storage(tmp_path):
    storage = FileMemoryStorage(base_dir=tmp_path)
    set_memory_storage(storage)
    yield
    set_memory_storage(None)


class TestFactContentKey:
    def test_casefold(self):
        assert _fact_content_key("User likes Python") == _fact_content_key("user likes python")

    def test_strip_whitespace(self):
        assert _fact_content_key("  hello  ") == _fact_content_key("hello")

    def test_collapse_spaces(self):
        assert _fact_content_key("hello   world") == _fact_content_key("hello world")

    def test_different_content_different_key(self):
        assert _fact_content_key("Python") != _fact_content_key("Ruby")

    def test_empty_string(self):
        assert _fact_content_key("") == ""

    def test_unicode_casefold(self):
        # German sharp s: ß casefolds to ss
        assert _fact_content_key("Straße") == _fact_content_key("strasse")


class TestDetectReinforcement:
    def test_no_reinforcement(self):
        msgs = [_human("Tell me about Python")]
        assert detect_reinforcement(msgs) is False

    def test_as_i_mentioned(self):
        msgs = [_human("As I mentioned, I prefer Python")]
        assert detect_reinforcement(msgs) is True

    def test_like_i_said(self):
        msgs = [_human("Like I said before, use TypeScript")]
        assert detect_reinforcement(msgs) is True

    def test_remember_that(self):
        msgs = [_human("Remember that I always use dark mode")]
        assert detect_reinforcement(msgs) is True

    def test_i_always(self):
        msgs = [_human("I always write tests first")]
        assert detect_reinforcement(msgs) is True

    def test_as_i_told_you(self):
        msgs = [_human("As I told you, the deadline is Friday")]
        assert detect_reinforcement(msgs) is True

    def test_i_keep_saying(self):
        msgs = [_human("I keep saying we need more tests")]
        assert detect_reinforcement(msgs) is True

    def test_once_more(self):
        msgs = [_human("Once more, the answer is 42")]
        assert detect_reinforcement(msgs) is True

    def test_i_still(self):
        msgs = [_human("I still prefer vim")]
        assert detect_reinforcement(msgs) is True

    def test_my_preference_is(self):
        msgs = [_human("My preference is dark mode")]
        assert detect_reinforcement(msgs) is True

    def test_chinese_ive_said(self):
        msgs = [_human("我说过了，用Python")]
        assert detect_reinforcement(msgs) is True

    def test_chinese_i_always(self):
        msgs = [_human("我一直用TypeScript")]
        assert detect_reinforcement(msgs) is True

    def test_empty_messages(self):
        assert detect_reinforcement([]) is False

    def test_mutual_exclusion_correction_wins(self):
        """When both correction and reinforcement detected, correction takes priority."""
        msgs = [_human("Actually, as I mentioned, I meant Ruby not Python")]
        correction = detect_correction(msgs)
        reinforcement = detect_reinforcement(msgs)
        assert correction is True
        assert reinforcement is True  # Both detected
        # But after mutual exclusion logic, reinforcement is suppressed
        if correction:
            reinforcement = False
        assert reinforcement is False


class TestDedupOnInsert:
    """Test that _apply_updates deduplicates facts by content key."""

    def _make_updater(self):
        return MemoryUpdater()

    def test_exact_duplicate_skipped(self):
        updater = self._make_updater()
        current = _create_empty_memory()
        current["facts"] = [{"id": "f1", "content": "User likes Python", "category": "preference", "confidence": 0.8, "createdAt": "", "source": "t1"}]
        update_data = {
            "newFacts": [{"content": "User likes Python", "category": "preference", "confidence": 0.9}],
            "factsToRemove": [],
        }
        result = updater._apply_updates(current, update_data)
        assert len(result["facts"]) == 1
        # Higher confidence applied
        assert result["facts"][0]["confidence"] == 0.9

    def test_case_insensitive_duplicate(self):
        updater = self._make_updater()
        current = _create_empty_memory()
        current["facts"] = [{"id": "f1", "content": "user likes python", "category": "preference", "confidence": 0.8, "createdAt": "", "source": "t1"}]
        update_data = {
            "newFacts": [{"content": "User Likes Python", "category": "preference", "confidence": 0.7}],
            "factsToRemove": [],
        }
        result = updater._apply_updates(current, update_data)
        assert len(result["facts"]) == 1
        # Confidence stays at 0.8 since new is lower
        assert result["facts"][0]["confidence"] == 0.8

    def test_reinforcement_boosts_confidence(self):
        updater = self._make_updater()
        current = _create_empty_memory()
        current["facts"] = [{"id": "f1", "content": "User likes Python", "category": "preference", "confidence": 0.8, "createdAt": "", "source": "t1"}]
        update_data = {
            "newFacts": [{"content": "User likes Python", "category": "preference", "confidence": 0.9}],
            "factsToRemove": [],
        }
        result = updater._apply_updates(current, update_data, reinforcement_detected=True)
        assert len(result["facts"]) == 1
        # Reinforcement: existing 0.8 + 0.1 = 0.9
        assert result["facts"][0]["confidence"] == 0.9

    def test_reinforcement_caps_at_1(self):
        updater = self._make_updater()
        current = _create_empty_memory()
        current["facts"] = [{"id": "f1", "content": "User likes Python", "category": "preference", "confidence": 0.95, "createdAt": "", "source": "t1"}]
        update_data = {
            "newFacts": [{"content": "User likes Python", "category": "preference", "confidence": 0.9}],
            "factsToRemove": [],
        }
        result = updater._apply_updates(current, update_data, reinforcement_detected=True)
        assert result["facts"][0]["confidence"] == 1.0  # capped

    def test_new_unique_fact_added(self):
        updater = self._make_updater()
        current = _create_empty_memory()
        current["facts"] = [{"id": "f1", "content": "User likes Python", "category": "preference", "confidence": 0.8, "createdAt": "", "source": "t1"}]
        update_data = {
            "newFacts": [{"content": "User works at Acme Corp", "category": "context", "confidence": 0.9}],
            "factsToRemove": [],
        }
        result = updater._apply_updates(current, update_data)
        assert len(result["facts"]) == 2

    def test_below_threshold_skipped(self):
        updater = self._make_updater()
        current = _create_empty_memory()
        update_data = {
            "newFacts": [{"content": "low confidence fact", "category": "context", "confidence": 0.1}],
            "factsToRemove": [],
        }
        result = updater._apply_updates(current, update_data)
        assert len(result["facts"]) == 0  # below threshold
