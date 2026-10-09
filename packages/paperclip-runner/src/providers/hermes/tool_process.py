"""Apply the execution policy to native tool subprocesses, including shells.

Path argument checks alone cannot authorize arbitrary commands. This adapter
keeps Hermes's tools but places their child processes behind the host sandbox.
"""
import contextvars
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

tool_policy = contextvars.ContextVar("paperclip_tool_process_policy", default=None)
PROVIDER_SECRETS = frozenset({"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "XAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "AWS_BEARER_TOKEN_BEDROCK"})


def sandbox_command(command, *, cwd, policy, assigned):
    if isinstance(command, str):
        raise PermissionError("Managed Hermes requires an explicit subprocess argument list")
    protected = [str(Path(path).resolve()) for path in policy.get("protectedPaths", [])]
    readonly = [str(Path(path).resolve()) for path in assigned]
    if sys.platform == "darwin":
        if not Path("/usr/bin/sandbox-exec").is_file():
            raise PermissionError("Hermes command execution requires macOS sandbox-exec")
        # libdispatch requires its own process identity during initialization.
        # Other processes remain hidden so ps cannot recover provider secrets.
        rules = ["(version 1)", "(allow default)", "(deny process-info*)", "(allow process-info* (target self))"]
        rules += [f"(deny file-read* file-write* (subpath {json.dumps(path)}))" for path in protected]
        rules += [f"(deny file-write* (subpath {json.dumps(path)}))" for path in readonly]
        return ["/usr/bin/sandbox-exec", "-p", "\n".join(rules), *command]
    if sys.platform == "linux":
        bwrap = shutil.which("bwrap")
        if not bwrap:
            raise PermissionError("Hermes command execution requires bubblewrap in the runner image")
        # Ordinary bind mounts disable device access. Provide bubblewrap's
        # minimal /dev so native shell redirects and mktemp work; apply the
        # protected and assigned overlays afterwards so they remain binding.
        args = [bwrap, "--die-with-parent", "--unshare-pid", "--bind", "/", "/", "--proc", "/proc", "--dev", "/dev"]
        for path in protected:
            args += ["--tmpfs", path]
        for path in readonly:
            args += ["--ro-bind", path, path]
        return [*args, "--chdir", cwd, "--", *command]
    raise PermissionError("Hermes commands are not qualified on this platform")


def install_tool_process_policy():
    original = subprocess.Popen

    class ManagedPopen(original):
        def __init__(self, args, *positional, **kwargs):
            context = tool_policy.get()
            if context is not None:
                if positional or kwargs.get("shell") or kwargs.get("executable"):
                    raise PermissionError("Unsupported managed Hermes subprocess launch")
                policy, assigned = context
                args = sandbox_command(args, cwd=str(kwargs.get("cwd") or os.getcwd()), policy=policy, assigned=assigned)
                kwargs["env"] = {key: value for key, value in (kwargs.get("env") or os.environ).items()
                                 if key not in PROVIDER_SECRETS and not key.startswith("PAPERCLIP_")}
            super().__init__(args, *positional, **kwargs)

    subprocess.Popen = ManagedPopen
