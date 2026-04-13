"""Tests for correction detection in memory pipeline."""

import pytest
from langchain_core.messages import AIMessage, HumanMessage

from deerflow.agents.middlewares.memory_middleware import (
    _extract_message_text,
    detect_correction,
)


def _human(text) -> HumanMessage:
    return HumanMessage(content=text)


def _ai(text: str) -> AIMessage:
    return AIMessage(content=text)


class TestExtractMessageText:
    def test_string_content(self):
        assert _extract_message_text(_human("hello")) == "hello"

    def test_list_content(self):
        msg = _human([{"type": "text", "text": "hello"}, {"type": "image_url", "image_url": "..."}])
        text = _extract_message_text(msg)
        assert "hello" in text

    def test_empty_content(self):
        assert _extract_message_text(_human("")) == ""


class TestDetectCorrection:
    def test_no_correction(self):
        msgs = [_human("Tell me about Python"), _ai("Python is a language")]
        assert detect_correction(msgs) is False

    def test_actually_correction(self):
        msgs = [_human("Actually, I meant JavaScript not Python")]
        assert detect_correction(msgs) is True

    def test_no_i_meant(self):
        msgs = [_human("No, I meant the other one")]
        assert detect_correction(msgs) is True

    def test_thats_wrong(self):
        msgs = [_human("That's wrong, it should be 42")]
        assert detect_correction(msgs) is True

    def test_thats_incorrect(self):
        msgs = [_human("That's incorrect")]
        assert detect_correction(msgs) is True

    def test_not_x_but_y(self):
        msgs = [_human("Not Python, but Ruby")]
        assert detect_correction(msgs) is True

    def test_i_was_wrong(self):
        msgs = [_human("I was wrong about that")]
        assert detect_correction(msgs) is True

    def test_correction_word(self):
        msgs = [_human("A small correction: the date is March not April")]
        assert detect_correction(msgs) is True

    def test_let_me_correct(self):
        msgs = [_human("Let me correct myself")]
        assert detect_correction(msgs) is True

    def test_should_have_said(self):
        msgs = [_human("I should have said TypeScript")]
        assert detect_correction(msgs) is True

    def test_what_i_meant_was(self):
        msgs = [_human("What I meant was the other approach")]
        assert detect_correction(msgs) is True

    def test_sorry_i_meant(self):
        msgs = [_human("Sorry, I meant 100 not 200")]
        assert detect_correction(msgs) is True

    def test_chinese_not_right(self):
        msgs = [_human("不对，应该是这样的")]
        assert detect_correction(msgs) is True

    def test_chinese_misspoke(self):
        msgs = [_human("我说错了")]
        assert detect_correction(msgs) is True

    def test_only_checks_recent_window(self):
        """Correction in old messages (beyond last 3 human) should be ignored."""
        msgs = [
            _human("Actually, I meant something else"),
            _ai("OK"),
            _human("What is 1+1"),
            _ai("2"),
            _human("And 2+2"),
            _ai("4"),
            _human("Thanks"),
        ]
        # Only last 3 human messages: "What is 1+1", "And 2+2", "Thanks"
        assert detect_correction(msgs) is False

    def test_correction_in_recent_window(self):
        msgs = [
            _human("Hello"),
            _ai("Hi"),
            _human("Actually, I was wrong about my job"),
        ]
        assert detect_correction(msgs) is True

    def test_empty_messages(self):
        assert detect_correction([]) is False

    def test_only_ai_messages(self):
        msgs = [_ai("Actually, let me correct that")]
        assert detect_correction(msgs) is False  # AI messages ignored
