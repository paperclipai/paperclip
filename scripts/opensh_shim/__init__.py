"""
OpenShell sandbox shim — SAG-2357 production routing flip.

Production config (non-interactive agent paths):
  OPENSH_SANDBOX_ENABLED=1
  OPENSH_SANDBOX_TAG=0.0.47
  OPENSH_USE_GRPC=1
  OPENSH_MACOS_FALLBACK=container
  OPENSH_POOL_SIZE=3
"""
from .config import ShimConfig
from .pool import SandboxPool
from .shim import OpenShellShim

__all__ = ["ShimConfig", "SandboxPool", "OpenShellShim"]
