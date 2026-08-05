"""Configuration for the supported OpenShell 0.0.47 CLI contract."""
from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class ShimConfig:
    """The intentionally small, documented OpenShell configuration surface."""

    enabled: bool = False
    sandbox_image: str | None = None
    workdir: str = "/workspace/enrichment-stack"
    timeout_seconds: int = 900

    @classmethod
    def from_env(cls) -> "ShimConfig":
        enabled = os.environ.get("OPENSH_SANDBOX_ENABLED", "0") == "1"
        image = os.environ.get("OPENSH_SANDBOX_IMAGE") or None
        if enabled and not image:
            raise RuntimeError("OPENSH_SANDBOX_IMAGE is required when OpenShell is enabled")
        return cls(enabled=enabled, sandbox_image=image)
