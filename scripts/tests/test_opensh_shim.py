"""Contract tests for the installed OpenShell 0.0.47 CLI integration."""
from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest

sys.path.insert(0, str(Path(__file__).parents[2]))

from scripts.opensh_shim.config import ShimConfig
from scripts.opensh_shim.remote_dispatcher import main as remote_main
from scripts.opensh_shim.shim import ENV_ALLOWLIST, OpenShellShim


def _source_root() -> tempfile.TemporaryDirectory[str]:
    root = tempfile.TemporaryDirectory()
    for relative in ("enrichment", "pilot-artifacts", "scripts/opensh_shim"):
        path = Path(root.name) / relative
        path.mkdir(parents=True)
        (path / "keep.txt").write_text("ok")
    (Path(root.name) / "enrichment" / ".env").write_text("SECRET=nope")
    return root


class TestConfig:
    def test_disabled_is_default(self):
        with patch.dict(os.environ, {}, clear=True):
            assert ShimConfig.from_env() == ShimConfig()

    def test_enabled_requires_documented_image(self):
        with patch.dict(os.environ, {"OPENSH_SANDBOX_ENABLED": "1"}, clear=True):
            with pytest.raises(RuntimeError, match="OPENSH_SANDBOX_IMAGE"):
                ShimConfig.from_env()

    def test_enabled_uses_only_image_configuration(self):
        with patch.dict(os.environ, {"OPENSH_SANDBOX_ENABLED": "1", "OPENSH_SANDBOX_IMAGE": "registry/image:1"}, clear=True):
            cfg = ShimConfig.from_env()
        assert cfg.enabled and cfg.sandbox_image == "registry/image:1"
        assert cfg.workdir == "/workspace/enrichment-stack"
        assert cfg.timeout_seconds == 900


class TestOpenShellShim:
    def test_direct_mode_runs_canonical_command_with_allowlisted_environment(self):
        shim = OpenShellShim(ShimConfig())
        with patch("subprocess.run") as run:
            run.return_value = subprocess.CompletedProcess([], 0, "", "")
            shim.run(["python3", "-m", "enrichment.dispatcher"], cwd="/source", env={"PATH": "/bin", "SECRET": "no"})
        assert run.call_args.args[0] == ["python3", "-m", "enrichment.dispatcher"]
        assert run.call_args.kwargs["env"] == {"PATH": "/bin"}

    def test_enabled_uses_only_documented_cli_sequence_and_scrubs_staging(self):
        shim = OpenShellShim(ShimConfig(enabled=True, sandbox_image="registry/image:1"))
        recorded: list[list[str]] = []
        secret = "should-never-be-an-argv"

        def invoke(argv, **kwargs):
            recorded.append(argv)
            return subprocess.CompletedProcess(argv, 0, '{"total": 1, "done": 1, "failed": 0, "cap_paused": false}\n', "")

        with _source_root() as source, patch("subprocess.run", side_effect=invoke):
            result = shim.run(["python3", "-m", "enrichment.dispatcher"], cwd=source,
                              env={"PATH": "/bin", "DATABASE_URL": secret, "SECRET": secret})
        assert result.returncode == 0
        assert len(recorded) == 4
        assert recorded[0][:4] == ["openshell", "sandbox", "create", "--name"]
        assert recorded[0][5:7] == ["--from", "registry/image:1"]
        assert recorded[1][:4] == ["openshell", "sandbox", "upload", "--no-git-ignore"]
        assert recorded[2][-3:] == ["python3", "-m", "scripts.opensh_shim.remote_dispatcher"]
        assert recorded[2][2:10] == ["exec", "--name", recorded[2][4], "--workdir", "/workspace/enrichment-stack", "--timeout", "900", "--no-tty"]
        assert recorded[3][:3] == ["openshell", "sandbox", "delete"]
        assert all(secret not in part for argv in recorded for part in argv)

    def test_enabled_deletes_once_when_upload_fails(self):
        shim = OpenShellShim(ShimConfig(enabled=True, sandbox_image="registry/image:1"))
        calls: list[list[str]] = []

        def invoke(argv, **kwargs):
            calls.append(argv)
            return subprocess.CompletedProcess(argv, 1 if argv[2] == "upload" else 0, "", "upload failed")

        with _source_root() as source, patch("subprocess.run", side_effect=invoke):
            result = shim.run(["python3", "-m", "enrichment.dispatcher"], cwd=source, env={})
        assert result.returncode == 1
        assert [argv[2] for argv in calls] == ["create", "upload", "delete"]


class TestRemoteDispatcher:
    def test_unlinks_envelope_before_exec_and_uses_canonical_argv(self):
        with tempfile.TemporaryDirectory() as temp:
            runtime = Path(temp) / "runtime.json"
            runtime.write_text(json.dumps({"PATH": "/bin", "ENRICHMENT_COMPANY_ID": "company-a"}))
            runtime.chmod(0o600)
            with patch("scripts.opensh_shim.remote_dispatcher.RUNTIME_PATH", runtime), patch("os.execvpe") as execvpe:
                remote_main()
            assert not runtime.exists()
            assert execvpe.call_args.args == (
                "python3", ["python3", "-m", "enrichment.dispatcher"],
                {"PATH": "/bin", "ENRICHMENT_COMPANY_ID": "company-a"},
            )

    def test_envelope_requires_allowlisted_string_values(self):
        with tempfile.TemporaryDirectory() as temp:
            runtime = Path(temp) / "runtime.json"
            runtime.write_text(json.dumps({"NOPE": "value", "PATH": 1}))
            with patch("scripts.opensh_shim.remote_dispatcher.RUNTIME_PATH", runtime):
                with pytest.raises(RuntimeError, match="invalid OpenShell runtime envelope"):
                    remote_main()
            assert not runtime.exists()


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__]))
