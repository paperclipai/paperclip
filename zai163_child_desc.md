## Critical: localization leak into wrong repo

The board (ZAI-163) flagged that localization changes appeared in `C:\Users\vibecoder_blogger\PycharmProjects\paperclip` — that is the **upstream public** `paperclipai/paperclip` repo, not our `paperclip_fork_Enterprise` working tree. **Any changes there are forbidden.**

### Current state of the wrong repo (verified by CEO)

- Path: `C:\Users\vibecoder_blogger\PycharmProjects\paperclip`
- Remote: `origin → https://github.com/paperclipai/paperclip.git` (the public upstream)
- Active branch: `zai-24-fix-ru-access-roles-board`
- Uncommitted: 75 modified files (de/el/en/es/pt/ru/uk/zh locale JSONs + several `ui/src/...` files + `server/src/worktree-config.ts`) plus 5 untracked
- i18n commits already on the branch (NOT pushed to upstream remote yet, but local):
  - `46d86080 [i18n/R3] ZAI-140: localize dashboard Agents heading, run-status labels, chart legend`
  - `c2904e04 i18n(ru): translate access_roles.board to Совет`
  - `347938b9 i18n(el): add missing cli_auth.sign_in_btn to Greek locale`

### Probable root cause

The Localization Agent (`2c35ae09-781d-4a7c-880b-8abd833fd682`, currently `running`) appears to have a worktree, instructions, or a hard-coded `cwd` pointing at the wrong path. Verify in its instructions/agent config and the issue execution-workspace settings for any localization issues currently in flight.

### Required actions (in order)

1. **Stop the bleeding immediately.** Pause the Localization Agent or block any in-flight heartbeats from writing to `C:\Users\vibecoder_blogger\PycharmProjects\paperclip`. Confirm no other agents have a worktree there.
2. **Audit scope.** Capture full `git status` and `git log master..HEAD --oneline` in the wrong repo. Capture the diff of uncommitted changes too. Save under `qa-zai163-leak/` in `_fork_Enterprise` for the record.
3. **Preserve valuable work.** For each i18n commit and each modified file in the wrong repo, check whether the equivalent change is already in `paperclip_fork_Enterprise`. If not, cherry-pick / port the WIP into the fork on the appropriate branch (likely `vib-1171-2652-2760-3582-localization` or a successor) through the normal review path. **Do NOT** push the wrong-repo branch to the public `paperclipai/paperclip` remote.
4. **Clean the wrong repo.** Once preserved, restore the wrong repo to a clean state on its tracked upstream branch. Coordinate with the board before any destructive op (`reset --hard`, branch deletion, `git push`).
5. **Add a guardrail.** Either: hard-code the Localization Agent's working directory to `C:\Users\vibecoder_blogger\PycharmProjects\paperclip_fork_Enterprise` in its instructions/config, AND/OR add a pre-flight check in the heartbeat that asserts `git remote get-url origin` matches the fork and aborts if the cwd resolves outside `_fork_Enterprise`. Document the safeguard in the Localization Agent's `AGENTS.md`.
6. **Report back** with: what was preserved (commits cherry-picked, files ported), what was discarded, the exact guardrail that now prevents recurrence, and confirmation the wrong repo is clean and that the Localization Agent only operates in `_fork_Enterprise`.

### Hard rules

- **Do not** force-push to the public `paperclipai/paperclip` remote.
- **Do not** rewrite history on shared branches without board sign-off.
- **Do not** delete uncommitted changes before confirming they are duplicated in `_fork_Enterprise`.

Return to the CEO with status `in_review` once steps 1–5 are complete.
