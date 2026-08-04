"""OpenShell shim config — reads OPENSH_* env vars."""
from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass
class ShimConfig:
    enabled: bool = False
    sandbox_tag: str = "0.0.47"
    use_grpc: bool = True
    macos_fallback: str = "container"  # container | none
    pool_size: int = 3
    # Alert threshold: total pool RAM in MiB before a Paperclip notification fires
    ram_alert_mib: float = 200.0

    @classmethod
    def from_env(cls) -> "ShimConfig":
        return cls(
            enabled=os.environ.get("OPENSH_SANDBOX_ENABLED", "0") == "1",
            sandbox_tag=os.environ.get("OPENSH_SANDBOX_TAG", "0.0.47"),
            use_grpc=os.environ.get("OPENSH_USE_GRPC", "1") == "1",
            macos_fallback=os.environ.get("OPENSH_MACOS_FALLBACK", "container"),
            pool_size=int(os.environ.get("OPENSH_POOL_SIZE", "3")),
            ram_alert_mib=float(os.environ.get("OPENSH_RAM_ALERT_MIB", "200")),
        )
