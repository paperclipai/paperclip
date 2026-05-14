"""Tests for the CLI entry point."""

from unittest.mock import patch, AsyncMock

import pytest
from typer.testing import CliRunner

from blackbox.cli import app
from blackbox.models import AgencyDossier, RFPContext

runner = CliRunner()


class TestCli:
    def test_version(self):
        result = runner.invoke(app, ["version"])
        assert result.exit_code == 0
        assert "0.1.0" in result.stdout

    def test_no_args_shows_help(self):
        result = runner.invoke(app, [])
        # Typer no_args_is_help exits with code 0 or 2 depending on version
        assert result.exit_code in (0, 2)
        output = result.stdout + (result.stderr or "")
        assert "research" in output.lower() or "usage" in output.lower() or "commands" in output.lower()

    def test_research_no_file_no_agency(self):
        with patch.dict("os.environ", {"ANTHROPIC_API_KEY": "test", "BRAVE_API_KEY": "test"}):
            result = runner.invoke(app, ["research"])
        assert result.exit_code == 1

    def test_research_missing_api_key(self):
        # Patch Path.exists to prevent .env auto-load from injecting keys
        with patch.dict("os.environ", {}, clear=True), \
             patch("blackbox.cli.Path.exists", return_value=False):
            result = runner.invoke(app, ["research", "--agency", "FDA"])
        assert result.exit_code == 1
        assert "ANTHROPIC_API_KEY" in result.stdout or "Missing" in result.stdout

    def test_research_file_not_found(self):
        with patch.dict("os.environ", {"ANTHROPIC_API_KEY": "test", "BRAVE_API_KEY": "test"}):
            result = runner.invoke(app, ["research", "/nonexistent/file.pdf"])
        assert result.exit_code == 1
        assert "not found" in result.stdout.lower() or "Error" in result.stdout
