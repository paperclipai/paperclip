---
name: paperclip-wsl
description: Run this Paperclip checkout with its configured native Linux toolchain in WSL. Use for development, Git, dependency installation, builds, tests, migrations, server lifecycle and provider diagnostics when .paperclip/wsl.local.json exists, including work launched by a Windows assistant.
---

# Paperclip in WSL

Read `.paperclip/wsl.local.json` for the selected distribution, normal user,
Linux checkout, native Node executable, tool directories and instance home.
Keep these machine values local and untracked. Use this canonical instruction
from both Codex and Claude; the Claude discovery entry only links here.

For an initial profile, copy the following shape into that ignored file and
set each value from the selected installation. Keep the same profile in the
Windows and Linux checkouts. `binPaths` controls native tool discovery; add
scoped Rust directories and `CARGO_HOME` / `RUSTUP_HOME` when applicable.

```json
{
  "distro": "Ubuntu", "user": "your-user",
  "checkout": "/home/your-user/Projects/paperclip",
  "node": "/usr/bin/node",
  "paperclipHome": "/home/your-user/.paperclip",
  "instanceId": "default", "port": 3100,
  "binPaths": ["/usr/local/bin", "/usr/bin", "/bin"],
  "capacityPath": "/mnt/c"
}
```

Set `capacityPath` to the actual Windows volume containing this distribution's
virtual disk. Free space reported inside the Linux virtual disk alone does not
prove that its host volume can grow.

Configured embedded database, local storage and encryption sections must set
their data paths explicitly. Schema defaults contain the default instance path
and can select a different home. Home-relative and relative paths are accepted
when they resolve to native Linux storage.

Run the helper from the repository root:

```sh
node skills/paperclip-wsl/scripts/paperclip-wsl.mjs preflight
node skills/paperclip-wsl/scripts/paperclip-wsl.mjs exec git status --short
node skills/paperclip-wsl/scripts/paperclip-wsl.mjs exec pnpm verify
```

On Windows, the helper only launches the selected Linux checkout through WSL.
On Linux, it verifies the checkout, user, instance, native executables and free
host storage before running the command. Arguments are passed directly,
including spaces and Unicode. Run Git, installs, builds, database migrations,
tests and provider processes inside Linux. A Windows editor may edit files.
When handing off existing edits in a Windows worktree, commit those edits with
Windows Git. Use Linux Git for the configured Linux checkout.

Use `doc/DEVELOPING.md` for the owning start/stop commands and focused checks.
Run `preflight --runner` before preparing an instance or starting native agent
tests; Runner requires glibc 2.39 or newer. An operating system upgrade affects
the entire distribution, so obtain approval before doing one.
Run `preflight --health` to verify a running instance launched through this helper.
The check requires the listener's initial home, config and instance environment;
it refuses an older unlabelled process rather than inferring ownership from its
port. Adopt an existing instance by restarting its selected service through the
helper after checking ownership. Start with `exec pnpm dev`
only after checking the selected instance and existing service ownership.
Stop that instance through `exec pnpm dev:stop`; preserve unrelated processes.
Follow `doc/DOCKER.md` for an explicitly requested release-image qualification.

Preserve approval gates, budget limits, scope boundaries and full checks of
changed skill files. Keep the Windows migration source and recovery files
until separately authorized for cleanup. Do not automatically copy an instance,
seed a database, create a runner, select a qualification instance or fall back
to Windows tools when preflight fails. Correct the reported configuration.
