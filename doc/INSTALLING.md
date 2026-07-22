# Installing Paperclip

Paperclip supports a managed installation, an ephemeral `npx` tryout, a
traditional global npm installation, and development from a source checkout.
The managed installation is recommended because it provides atomic updates,
rollback, git-ref installs, and a stable entrypoint for the background service.

## Recommended Install

On macOS, Linux, or WSL2:

```sh
curl -fsSL https://paperclip.ing/install.sh | bash
```

The bootstrap script:

1. verifies that the platform is supported;
2. ensures Node.js 20 or newer is available;
3. delegates installation to `paperclipai install`;
4. starts interactive onboarding when stdin and stdout are terminals.

The script prints and confirms any command that requires elevated privileges.
Use `--no-prompt` for automation and `--no-onboard` to stop after installing:

```sh
curl -fsSL https://paperclip.ing/install.sh | bash -s -- --no-prompt --no-onboard
paperclipai onboard --yes
```

If the vanity installer endpoint is unavailable, fetch the same
release-controlled source from GitHub raw content:

```sh
raw_base=https://raw.githubusercontent.com/paperclipai/paperclip
curl -fsSL "$raw_base/master/scripts/install.sh" | bash
```

For audits or incident response, pin the raw URL to a release tag or commit
SHA instead of `master`, download it first, and compare it with the published
checksum at `https://paperclip.ing/install.sh.sha256`.

Each installer flag also has a `PAPERCLIP_INSTALL_*` environment-variable
equivalent. This helps where passing arguments through a pipe is awkward.

## Managed Install Layout

Managed code is separate from instance data:

```text
~/.paperclip/cli/
├── install.json
├── current -> installs/npm/2026.720.0
└── installs/
    ├── npm/<version>/
    └── git/<sha12>/

~/.local/bin/paperclipai
```

The `paperclipai` shim remains stable while `current` switches atomically
between complete payloads. Paperclip keeps the two previous managed payloads
for rollback. Configuration, databases, uploads, logs, secrets, and workspaces
remain under `~/.paperclip/instances/` and are not stored inside CLI payloads.

If `~/.local/bin` is not on `PATH`, the installer offers to update the relevant
shell startup file when running interactively. Non-interactive installs print
the exact `export PATH` command instead of editing shell files silently.

## Install Sources

Install the current stable release:

```sh
npx --registry https://registry.npmjs.org paperclipai install
```

Install canary or pin an exact published version:

```sh
npx --registry https://registry.npmjs.org paperclipai install --canary
npx --registry https://registry.npmjs.org paperclipai install --version 2026.720.0
```

Install a branch, tag, or commit from GitHub:

```sh
npx --registry https://registry.npmjs.org paperclipai install --ref master
npx --registry https://registry.npmjs.org paperclipai install --ref v2026.720.0
npx --registry https://registry.npmjs.org paperclipai install --ref <commit-sha>
```

Use a fork by adding `--repo owner/repository`:

```sh
npx --registry https://registry.npmjs.org paperclipai install \
  --repo your-org/paperclip \
  --ref your-branch
```

Git-ref installs resolve the requested ref to an exact commit before building.
Review and trust the repository and ref: installing a git ref executes that
revision's package installation and release build scripts on your machine.

## Onboarding And The Service

Run onboarding after a non-interactive installation:

```sh
paperclipai onboard
```

Interactive onboarding asks whether Paperclip should run as a background
service when the platform supports one. Automated onboarding deliberately does
not install a service unless explicitly requested:

```sh
paperclipai onboard --yes                    # configure only; no service install
paperclipai onboard --yes --install-service  # explicit automation opt-in
paperclipai onboard --yes --no-install-service
```

Service commands are namespaced:

```sh
paperclipai service install
paperclipai service status
paperclipai service start
paperclipai service stop
paperclipai service restart
paperclipai service logs -f
paperclipai service uninstall
```

Paperclip uses a systemd user service on Linux and WSL2 systems with user
systemd, and a LaunchAgent on macOS. Containers, WSL1, and systems without a
supported user service manager receive foreground `paperclipai run` guidance
instead of a hard failure.

The service uses the stable managed-install shim, restarts after crashes, and
can start on login. On Linux, service installation may offer to enable user
lingering so it can continue without an active login session. The command
explains and confirms that system-level action before running it.

Use one server process per instance. `paperclipai run` refuses to start when
the same instance is already supervised; stop the service first or use
`--force` only when you intentionally accept the single-writer risk.

## Update And Rollback

Update according to the source and channel recorded in the install manifest:

```sh
paperclipai update
```

Select a different release source explicitly:

```sh
paperclipai update --latest
paperclipai update --canary
paperclipai update --version 2026.720.0
paperclipai update --ref master
paperclipai update --repo your-org/paperclip --ref your-branch
```

Managed updates create a database backup before switching payloads, verify the
new CLI, atomically flip `current`, and restart an installed service. A failed
install or verification leaves the previous payload active.

Roll back to the previous retained payload:

```sh
paperclipai update --rollback
```

The `upgrade` command is an alias for `update`. Exact versions and commit SHAs
are pinned; provide a new target when you want them to move.

## Other Installation Methods

Ephemeral tryout with no managed install:

```sh
npx --registry https://registry.npmjs.org paperclipai onboard --yes
```

Traditional global npm install:

```sh
npm install --global --registry https://registry.npmjs.org paperclipai
paperclipai onboard
```

Source checkout for development:

```sh
git clone https://github.com/paperclipai/paperclip.git
cd paperclip
pnpm install
pnpm dev
```

The managed `paperclipai update` command can update managed and global npm
installs. For source checkouts it reports the appropriate git workflow instead
of modifying the checkout automatically.

## Diagnose An Installation

Run:

```sh
paperclipai doctor
paperclipai service status
```

`doctor` checks the managed install store, manifest, `current` link, shim,
`PATH`, Node.js version, and service state. Service diagnostics cover unit-file
presence and drift, running state, configured port ownership, and the running
server version.

## Uninstall

Remove the background service and managed CLI payloads:

```sh
paperclipai service uninstall
paperclipai uninstall
```

`paperclipai uninstall` removes the managed shim, manifest, and CLI payloads.
It deliberately preserves `~/.paperclip/instances/`, including configuration,
databases, uploads, logs, secrets, backups, and workspaces. Back up and remove
that data separately only when you intend to delete the Paperclip instance.
