"""Tests for Paperclip integration."""

import pytest

from blackbox.paperclip import parse_task_for_research


class TestParseTaskForResearch:
    def test_simple_title(self):
        task = {"title": "Research FDA", "description": ""}
        result = parse_task_for_research(task)
        assert result["agency"] == "FDA"
        assert result["scope"] == ""

    def test_title_with_scope(self):
        task = {"title": "Research Texas DIR: IT modernization", "description": ""}
        result = parse_task_for_research(task)
        assert result["agency"] == "Texas DIR"
        assert result["scope"] == "IT modernization"

    def test_title_with_dash_separator(self):
        task = {"title": "Analyze Department of Veterans Affairs - Cloud migration", "description": ""}
        result = parse_task_for_research(task)
        assert result["agency"] == "Department of Veterans Affairs"
        assert result["scope"] == "Cloud migration"

    def test_description_fields(self):
        task = {
            "title": "New research task",
            "description": "agency: EPA\nscope: Environmental monitoring IT\nfile: /tmp/rfp.pdf",
        }
        result = parse_task_for_research(task)
        assert result["agency"] == "EPA"
        assert result["scope"] == "Environmental monitoring IT"
        assert result["rfp_path"] == "/tmp/rfp.pdf"

    def test_score_prefix(self):
        task = {"title": "Score Orange County CA", "description": ""}
        result = parse_task_for_research(task)
        assert result["agency"] == "Orange County CA"

    def test_empty_task(self):
        task = {"title": "", "description": ""}
        result = parse_task_for_research(task)
        assert result["agency"] == ""
        assert result["scope"] == ""
