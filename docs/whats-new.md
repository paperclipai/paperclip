# What's New — June 2026 Quickstart Overhaul

If you set up Gradata before June 2026 using the old multi-path quickstart (Option A/B/C), here's what changed and what you need to know.

---

## Single install path

The old quickstart offered three options:

- Option A: `npx gradata@latest` (zero-install)
- Option B: `npm install -g gradata` (global)
- Option C: `docker run ...` (Docker)

We've consolidated to one canonical path:

```bash
npx gradata@latest
```

This is the path we test, document, and support. The global install and Docker paths still work, but they're no longer documented or maintained as primary flows.

---

## Close your AI tools before setup

This is the most important behavioral change.

The setup wizard installs hooks into AI tool config files (Claude Code's `settings.json`, Cursor's config, etc.). If those tools are open when you run setup, they won't see the new hooks until you relaunch them — and in some cases, they'll overwrite the hook config when they exit.

**Before running `npx gradata@latest`:** close Claude Code, Cursor, Codex, and any other AI tools. Relaunch them after setup completes.

---

## Daemon runs in the foreground by default

Previously the daemon started in the background silently. Now it runs in the foreground so you can see what it's doing:

```
Gradata daemon running. Press Ctrl+C to stop.
```

To run in the background:

```bash
npx gradata@latest daemon --background
```

To restart later (e.g. after closing the terminal):

```bash
npx gradata@latest daemon
```

---

## Quick config commands changed

If you were running bare `gradata` commands (e.g. `gradata brain list`), those only work if you did a global install. With the npx path, use:

```bash
npx gradata@latest config show
npx gradata@latest brain list
npx gradata@latest sync status
```

---

## Bug fixes in this wave

- **DB path race condition (GRA-4059):** `GRADATA_DB_PATH` is now set explicitly before the daemon starts, fixing a crash on first run when the config file hadn't been written yet.
- **Install URL formatting (GRA-4119):** Fixed a missing space in the install instructions that caused copy-paste errors.
- **Status filter normalization (GRA-4140):** Issue list API now correctly handles both single-value and array `status` query params from Express.

---

## If you're upgrading from the old flow

1. Stop any running daemon: `Ctrl+C` or kill the process
2. Close all AI tools
3. Run `npx gradata@latest` — it will re-detect your tools and update hooks
4. Relaunch your AI tools

Your existing brain data and rules are preserved — the setup wizard doesn't touch `~/.gradata/brain/`.

---

Full docs at [docs.gradata.ai](https://docs.gradata.ai)
