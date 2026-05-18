# WSL2 + Cross-Compile Migration for djcowork2.0

Status: Proposal (2026-05-14)
Owners: Paperclip Workspace Director, djcowork2.0 CTO
Linked agents: Workspace Director, Workspace Operator, Runner Coordinator
Linked package: `doc/company-packages/compliance-first-ai-company/`

## Why

The current setup runs paperclip + all 27 codex agents on the Windows host,
all with `cwd: D:\code\djcowork2.0`. Three problems compound:

1. **No filesystem isolation.** Every engineer agent writes to the same
   working tree. Concurrent codex children fight over `.git/index.lock`,
   sccache locks, and target/ writes. This is a Windows stability root cause.
2. **No process group on Windows.** `server-utils.ts:64,74` shows
   `detached: false` on win32 — paperclip cannot kill the codex process tree,
   only the head. Orphaned codex children pile up.
3. **codex sandbox is degraded on Windows.** All agents run with
   `dangerouslyBypassApprovalsAndSandbox: true` because the Windows sandbox is
   not as complete as the Linux one. On Linux we can keep the sandbox on.

djcowork2.0 itself already configures `x86_64-pc-windows-gnullvm` with
LLVM-MinGW (`.cargo/config.toml:15-17`) and the windows-desktop-gate workflow
only runs `cargo check` on a self-hosted Windows runner — release artifacts
can be produced from Linux today with no source changes.

## Target architecture

```
Windows host
├── self-hosted GitHub runner (windows-build label)   [unchanged]
├── djcowork.exe smoke runs (DirectX 11 + GPU)        [Windows-only forever]
├── signtool / installer build                         [Windows-only forever]
└── VSCode (Remote-WSL into the Linux side)            [optional ergonomics]

WSL2 Ubuntu 24.04
├── ~/work/paperclip/                                  [git clone on ext4]
│   └── docker compose -f docker/docker-compose.yml up
├── ~/work/djcowork2.0/                                [git clone on ext4]
│   ├── cargo +1.88.0 check / clippy / test            [primary dev loop]
│   ├── cargo build --target x86_64-pc-windows-gnullvm
│   │   └── target/.../release/djcowork.exe → /mnt/d/dist/ → Windows run
│   └── per-task worktrees at ~/work/djcowork2.0-wt/<branch>
└── codex children (27 agent pool, max 15 live)
    ├── Workspace Operator dispatches each into its own worktree
    ├── systemd-run --user --scope --unit=codex-<id> wraps each
    └── MemoryMax=8G keeps a runaway agent off the host
```

The Windows host keeps **only** the things WSL cannot do:

- GPU-bound DirectX smoke (DirectComposition, DirectWrite render path)
- MSVC ABI compatibility check (`windows-desktop-gate.yml` already does this)
- Code signing
- End-user installer builds

## Migration steps

### 0. Prereqs (Windows host, one-time)

1. WSL2 enabled and Ubuntu-24.04 installed.
2. WSLg working (`wsl --update`).
3. Disk: at least 60 GB free inside the WSL ext4 vhdx (cargo target + agents).
4. Windows host keeps the existing self-hosted GitHub runner registered with
   the `windows-build` label — do not change.

### 1. Install LLVM-MinGW inside WSL2

```bash
cd ~
curl -L -o llvm-mingw.tar.xz \
  https://github.com/mstorsjo/llvm-mingw/releases/download/20260224/llvm-mingw-20260224-ucrt-ubuntu-22.04-x86_64.tar.xz
tar xJf llvm-mingw.tar.xz
mv llvm-mingw-20260224-ucrt-ubuntu-22.04-x86_64 ~/llvm-mingw
echo 'export PATH=$HOME/llvm-mingw/bin:$PATH' >> ~/.bashrc
exec bash
x86_64-w64-mingw32-clang --version   # smoke
```

### 2. Install Rust toolchain

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
. "$HOME/.cargo/env"
rustup install 1.88.0
rustup default 1.88.0
rustup target add x86_64-pc-windows-gnullvm
rustup component add clippy rustfmt
cargo install sccache --locked
cargo install cargo-deny --locked
```

### 3. Clone projects on WSL ext4 (NOT under /mnt/d)

```bash
mkdir -p ~/work
cd ~/work
git clone <paperclip-remote> paperclip
git clone <djcowork2.0-remote> djcowork2.0
```

Performance note: `/mnt/d` is a 9P passthrough into Windows NTFS and is
~10× slower for many-small-file workloads like `cargo build`. Do not put
either repo under `/mnt/`.

### 4. Wire the LLVM-MinGW linker for Linux

Either (a) add a host-specific `~/.cargo/config.toml`:

```toml
[target.x86_64-pc-windows-gnullvm]
linker = "/home/<you>/llvm-mingw/bin/x86_64-w64-mingw32-clang"
rustflags = ["-C", "link-arg=-lwinpthread"]
```

…or (b) propose a follow-up PR to djcowork2.0 making the repo
`.cargo/config.toml` use `${LLVM_MINGW_BIN}` env expansion (cargo supports
this in recent stable). Path (a) is non-invasive; path (b) is the long-term
fix and is included in the djcowork2.0 GitHub hardening plan.

Smoke:

```bash
cd ~/work/djcowork2.0
cargo +1.88.0 build --target x86_64-pc-windows-gnullvm -p djcowork --release
ls target/x86_64-pc-windows-gnullvm/release/djcowork.exe
```

Copy the `.exe` to `/mnt/d/dist/` and double-click on the Windows side.

### 5. Bring paperclip up on WSL2

```bash
cd ~/work/paperclip
docker compose -f docker/docker-compose.yml up -d
```

Then import the WSL2 variant of the company package:

```bash
cp doc/company-packages/compliance-first-ai-company/.paperclip.wsl2.yaml \
   doc/company-packages/compliance-first-ai-company/.paperclip.yaml
# sed-replace /home/dev to your actual $HOME if needed
sed -i "s|/home/dev|$HOME|g" \
   doc/company-packages/compliance-first-ai-company/.paperclip.yaml
npx paperclipai company import ./doc/company-packages/compliance-first-ai-company
```

### 6. Per-task worktree dispatch (Workspace Operator runtime change)

The Workspace Operator agent — once it boots — is now bound by the hard rules
in `agents/workspace-operator/AGENTS.md`. The script it should execute per
engineer task is:

```bash
# Inputs: BRANCH (e.g. fix/coma742-foo), AGENT_ID
WT=$HOME/work/djcowork2.0-wt/$BRANCH
if [ ! -d "$WT" ]; then
  git -C $HOME/work/djcowork2.0 worktree add "$WT" "$BRANCH" \
    2>/dev/null || \
  git -C $HOME/work/djcowork2.0 worktree add -b "$BRANCH" "$WT" origin/main
fi

# Tell paperclip to rewrite this engineer's cwd to $WT.
# (Implementation: PATCH /api/agents/<AGENT_ID> { adapter.config.cwd: $WT })

# Wrap dispatch in systemd-run cgroup
systemd-run --user --scope --unit=codex-$AGENT_ID-$$ \
  -p MemoryMax=8G -p CPUQuota=200% \
  -- /path/to/codex <args>
```

### 7. Validate

- Run the Phase 1 audit lane end-to-end with 3 engineer agents simultaneously
  on different branches — confirm worktree count grows, `.git/index.lock`
  contention disappears, and SIGTERM of one agent does not cascade.
- Compare CI signal: a PR opened from inside WSL2 should pass every
  required check on the existing self-hosted Linux runners
  (`quality / scope`, `cargo-deny`, etc.). windows-desktop-gate continues to
  run on the Windows runner.

## Rollback

Revert is a copy operation: `cp .paperclip.yaml.backup .paperclip.yaml`
followed by a re-import. Worktrees are destroyed with
`git worktree remove --force <path>`. Nothing in the source tree changes.

## Open questions

- Whether to also publish a `.paperclip.linuxnative.yaml` for a future
  cloud-runner deployment (paths would be `/srv/agents/djcowork2.0`). Out of
  scope for this migration.
- Whether the Workspace Director should treat the `windows-desktop-gate`
  workflow as a *runner lane* (so it can route DirectX smoke tasks to the
  Windows host explicitly). Recommended but tracked separately.

## References

- `agents/workspace-director/AGENTS.md` (hard rules, 2026-05-14)
- `agents/workspace-operator/AGENTS.md` (hard rules, 2026-05-14)
- `agents/runner-coordinator/AGENTS.md` (wall-time / cgroup rules, 2026-05-14)
- `.paperclip.wsl2.yaml` (Linux variant)
- `D:\code\djcowork2.0\.cargo\config.toml:15-17` (LLVM-MinGW already configured)
- `D:\code\djcowork2.0\.github\workflows\windows-desktop-gate.yml` (Windows
  runner role, unchanged by this migration)
- `D:\code\djcowork2.0\vendor\gpui-0.2.2\Cargo.toml:667-700` (windows crate
  0.61, target-cfg-gated, cross-compile-safe)
- `D:\paperclip\server\src\services\company-portability.ts:1700` (cwd is
  local-instance state, justifying the two-file approach)
