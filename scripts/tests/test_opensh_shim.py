"""Unit tests for scripts/opensh_shim — SAG-2357."""
from __future__ import annotations

import subprocess
import sys
import os
from unittest.mock import MagicMock, patch

import pytest

# Make scripts/ importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from scripts.opensh_shim.config import ShimConfig
from scripts.opensh_shim.shim import OpenShellShim
from scripts.opensh_shim.dispatcher_grpc import (
    _encode_varint,
    _build_exec_request,
    _decode_exec_response,
    _grpc_frame,
    _encode_string_field,
    _encode_uint32_field,
)


# ---------------------------------------------------------------------------
# ShimConfig
# ---------------------------------------------------------------------------

class TestShimConfig:
    def test_defaults_disabled(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("OPENSH_SANDBOX_ENABLED", None)
            cfg = ShimConfig.from_env()
        assert cfg.enabled is False

    def test_enabled_from_env(self):
        with patch.dict(os.environ, {"OPENSH_SANDBOX_ENABLED": "1"}):
            cfg = ShimConfig.from_env()
        assert cfg.enabled is True
        assert cfg.sandbox_tag == "0.0.47"
        assert cfg.use_grpc is True
        assert cfg.macos_fallback == "container"
        assert cfg.pool_size == 3
        assert cfg.ram_alert_mib == 200.0

    def test_custom_values(self):
        env = {
            "OPENSH_SANDBOX_ENABLED": "1",
            "OPENSH_SANDBOX_TAG": "0.0.48",
            "OPENSH_USE_GRPC": "0",
            "OPENSH_MACOS_FALLBACK": "none",
            "OPENSH_POOL_SIZE": "5",
            "OPENSH_RAM_ALERT_MIB": "150",
        }
        with patch.dict(os.environ, env):
            cfg = ShimConfig.from_env()
        assert cfg.sandbox_tag == "0.0.48"
        assert cfg.use_grpc is False
        assert cfg.macos_fallback == "none"
        assert cfg.pool_size == 5
        assert cfg.ram_alert_mib == 150.0

    def test_grpc_default_on(self):
        # OPENSH_USE_GRPC=1 is the production default
        with patch.dict(os.environ, {"OPENSH_SANDBOX_ENABLED": "1"}, clear=False):
            os.environ.pop("OPENSH_USE_GRPC", None)
            cfg = ShimConfig.from_env()
        assert cfg.use_grpc is True


# ---------------------------------------------------------------------------
# OpenShellShim — disabled path
# ---------------------------------------------------------------------------

class TestOpenShellShimDisabled:
    def test_passthrough_when_disabled(self):
        cfg = ShimConfig(enabled=False)
        shim = OpenShellShim(cfg, pool=None)
        result = shim.run(["echo", "hello"], timeout=5.0)
        assert result.returncode == 0

    def test_does_not_touch_pool_when_disabled(self):
        cfg = ShimConfig(enabled=False)
        pool = MagicMock()
        shim = OpenShellShim(cfg, pool=pool)
        shim.run(["true"], timeout=5.0)
        pool.acquire.assert_not_called()


# ---------------------------------------------------------------------------
# OpenShellShim — macOS paths
# ---------------------------------------------------------------------------

class TestOpenShellShimMacOS:
    def _make_shim(self, fallback: str = "container") -> OpenShellShim:
        cfg = ShimConfig(enabled=True, sandbox_tag="0.0.47", macos_fallback=fallback)
        return OpenShellShim(cfg, pool=MagicMock())

    def test_macos_container_fallback_calls_docker(self):
        shim = self._make_shim("container")
        shim._is_macos = True
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = subprocess.CompletedProcess([], 0, stdout="ok", stderr="")
            shim.run(["python3", "-c", "print(1)"], timeout=10.0)
        call_args = mock_run.call_args[0][0]
        assert call_args[0] == "docker"
        assert "openshell/sandbox:0.0.47" in call_args

    def test_macos_none_fallback_warns_and_runs_direct(self):
        shim = self._make_shim("none")
        shim._is_macos = True
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = subprocess.CompletedProcess([], 0, stdout="", stderr="")
            shim.run(["true"], timeout=5.0)
        # Should have called subprocess directly (not docker)
        call_args = mock_run.call_args[0][0]
        assert call_args == ["true"]


# ---------------------------------------------------------------------------
# OpenShellShim — Linux sandboxed path (pool)
# ---------------------------------------------------------------------------

class TestOpenShellShimLinux:
    def test_sandboxed_uses_pool_acquire(self):
        cfg = ShimConfig(enabled=True, use_grpc=False)
        pool = MagicMock()
        pool.acquire.return_value.__enter__ = MagicMock(return_value="sandbox-abc")
        pool.acquire.return_value.__exit__ = MagicMock(return_value=False)

        shim = OpenShellShim(cfg, pool=pool)
        shim._is_macos = False

        with patch("scripts.opensh_shim.dispatcher_cli.exec_in_sandbox") as mock_exec:
            mock_exec.return_value = subprocess.CompletedProcess([], 0, stdout="", stderr="")
            shim.run(["ls"], timeout=5.0)

        pool.acquire.assert_called_once()

    def test_no_pool_raises(self):
        cfg = ShimConfig(enabled=True)
        shim = OpenShellShim(cfg, pool=None)
        shim._is_macos = False
        with pytest.raises(RuntimeError, match="pool not initialized"):
            shim.run(["ls"])


# ---------------------------------------------------------------------------
# gRPC wire encoding
# ---------------------------------------------------------------------------

class TestGrpcWireEncoding:
    def test_encode_varint_single_byte(self):
        assert _encode_varint(0) == b"\x00"
        assert _encode_varint(1) == b"\x01"
        assert _encode_varint(127) == b"\x7f"

    def test_encode_varint_multi_byte(self):
        assert _encode_varint(128) == b"\x80\x01"
        assert _encode_varint(300) == b"\xac\x02"

    def test_build_exec_request_roundtrip(self):
        body = _build_exec_request("sandbox-1", ["ls", "-la"], timeout_ms=5000)
        # Should be non-empty bytes
        assert len(body) > 0
        assert isinstance(body, bytes)

    def test_grpc_frame_prefix(self):
        body = b"hello"
        frame = _grpc_frame(body)
        assert frame[0:1] == b"\x00"  # no compression flag
        assert len(frame) == 5 + len(body)
        import struct
        length = struct.unpack(">I", frame[1:5])[0]
        assert length == len(body)

    def test_decode_exec_response_defaults(self):
        # Empty/malformed response should return safe defaults
        result = _decode_exec_response(b"")
        assert result.exit_code == 0
        assert result.stdout == ""
        assert result.stderr == ""

    def test_encode_string_field_field_1(self):
        encoded = _encode_string_field(1, "test")
        # Field 1, wire type 2 = tag byte 0x0a
        assert encoded[0:1] == b"\x0a"
        assert b"test" in encoded

    def test_encode_uint32_field(self):
        encoded = _encode_uint32_field(3, 5000)
        # Field 3, wire type 0 = tag byte 0x18
        assert encoded[0:1] == b"\x18"


# ---------------------------------------------------------------------------
# SandboxPool RAM metrics
# ---------------------------------------------------------------------------

class TestSandboxPoolRam:
    def test_pool_ram_returns_float(self):
        from scripts.opensh_shim.pool import SandboxPool
        pool = SandboxPool("0.0.47", 3)
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = subprocess.CompletedProcess(
                [], 0,
                stdout="14.2MiB / 122.8GiB\n15.1MiB / 122.8GiB\n13.8MiB / 122.8GiB\n",
                stderr="",
            )
            ram = pool.pool_ram_mib()
        assert abs(ram - (14.2 + 15.1 + 13.8)) < 0.01

    def test_pool_ram_docker_unavailable(self):
        from scripts.opensh_shim.pool import SandboxPool
        pool = SandboxPool("0.0.47", 3)
        with patch("subprocess.run", side_effect=FileNotFoundError("docker not found")):
            ram = pool.pool_ram_mib()
        assert ram == 0.0

    def test_pool_ram_empty_output(self):
        from scripts.opensh_shim.pool import SandboxPool
        pool = SandboxPool("0.0.47", 3)
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = subprocess.CompletedProcess([], 0, stdout="", stderr="")
            ram = pool.pool_ram_mib()
        assert ram == 0.0


# ---------------------------------------------------------------------------
# PoolMonitor
# ---------------------------------------------------------------------------

class TestPoolMonitor:
    @pytest.mark.asyncio
    async def test_check_no_alert_below_threshold(self):
        from scripts.opensh_shim.monitor import PoolMonitor
        cfg = ShimConfig(enabled=True, ram_alert_mib=200.0)
        pool = MagicMock()
        pool.pool_ram_mib.return_value = 42.0
        pool.size.return_value = 3

        mon = PoolMonitor(cfg, pool, api_url="", api_key="", issue_id="", run_id="")
        metrics = await mon.check_and_alert()
        assert metrics["pool_ram_mib"] == 42.0
        assert metrics["alert_fired"] is False

    @pytest.mark.asyncio
    async def test_check_alert_above_threshold_no_creds(self):
        from scripts.opensh_shim.monitor import PoolMonitor
        cfg = ShimConfig(enabled=True, ram_alert_mib=200.0)
        pool = MagicMock()
        pool.pool_ram_mib.return_value = 250.0
        pool.size.return_value = 3

        # No API creds → alert_fired stays False (can't post)
        mon = PoolMonitor(cfg, pool, api_url="", api_key="", issue_id="", run_id="")
        metrics = await mon.check_and_alert()
        assert metrics["pool_ram_mib"] == 250.0
        assert metrics["alert_fired"] is False

    @pytest.mark.asyncio
    async def test_check_alert_fires_with_creds(self):
        from unittest.mock import AsyncMock
        from scripts.opensh_shim.monitor import PoolMonitor
        cfg = ShimConfig(enabled=True, ram_alert_mib=200.0)
        pool = MagicMock()
        pool.pool_ram_mib.return_value = 300.0
        pool.size.return_value = 3

        mon = PoolMonitor(
            cfg, pool,
            api_url="http://localhost:3100",
            api_key="token",
            issue_id="abc-123",
            run_id="run-1",
        )

        mock_resp = MagicMock()
        mock_resp.raise_for_status = MagicMock()

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_resp)

        with patch("httpx.AsyncClient") as mock_client_cls:
            mock_client_cls.return_value.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client_cls.return_value.__aexit__ = AsyncMock(return_value=False)
            metrics = await mon.check_and_alert()

        assert metrics["alert_fired"] is True
