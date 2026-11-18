# Shared Codex skill homes: disk and start-up measurement

Date: 2026-11-18. Design: `doc/plans/2026-11-18-shared-codex-home-caches.md`.

## Setup

- WSL2 Ubuntu (kernel 6.18.58.1-microsoft-standard-WSL2), 12 cores, Node 24.22.3.
  The machine also ran other sessions; load average was about 2 during the runs.
- Skill set: the largest assigned set on the local instance, read from one session's
  `codex-home/skills` (read only): 13 skills, 295,930,210 bytes, 25,040 files.
- Script: `packages/paperclip-runner/scripts/benchmark-codex-skill-homes.mjs`. It runs
  `prepareIsolatedCodexHome` for three fresh sessions without and with a skill home
  store, and reports wall time and bytes. Run after `pnpm run build:typescript`.

## Results

| Mode | Session 1 | Session 2 | Session 3 | Bytes in each session | Total for 3 sessions |
| --- | --- | --- | --- | --- | --- |
| Copy into `codex-home/skills` (before) | 45.9 s | 54.2 s | 55.7 s | 295.6 MB | 886.9 MB |
| Shared skill home (after) | 63.0 s (publishes) | 0.33 s | 0.85 s | 245 B | 306.9 MB |

The first session with a new skill set copies the skills once, hashes them for the
manifest and records file identities; later sessions with the same skills check only
inodes, sizes and ctimes. An earlier version that hashed every file on each reuse
took 16-33 s per warm launch because of per-file promise I/O; `sha256sum` over the
same files took 1.3 s. That is why reuse compares recorded file identities.

Instance-wide on the same machine: 274 sessions held 9.2 GB in `codex-home/skills`,
over 30 distinct skill sets. One home per set is about 2.0 GB.

## Real turn through the shared HOME

Codex 0.160.0 `app-server` on WSL Linux, ChatGPT login, `HOME` = a published skill
home with one skill (`alpha`: `SKILL.md` and `scripts/run.sh`), `CODEX_HOME` = a fresh
session home with `plugins`, `remote_plugin` and `apps` disabled. Prompt: use the alpha
skill and reply with the phrase `scripts/run.sh` echoes.

- Codex discovered the skill under `$HOME/.agents/skills`, read
  `<skill home>/.agents/skills/alpha/SKILL.md` and `.../scripts/run.sh`, and answered
  with the phrase. The turn completed.
- Files under the skill home changed during the turn: 0.
- Session `codex-home` after the turn: 4.2 MB, with no `plugins/` or
  `cache/remote_plugin_catalog`.

This used Codex's plain `read-only` sandbox, not Paperclip's filesystem policy; the
policy's read grant for `<skill home>/.agents/skills` is covered by unit tests.
Not measured: time to the provider's first event in a full Paperclip launch.
