# UPDATE-INSTRUCTIONS

How to update agent instruction files now that they live in version control.

## What lives here

```
agent-config/
  manifest.json                          # Active agents (id, name, role)
  sync.ps1 / sync.sh                     # Pull fork + copy into live agent dirs
  companies/
    {companyId}/
      agents/
        {agentId}/
          instructions/
            AGENTS.md                    # required entry file
            HEARTBEAT.md, SOUL.md, ...   # optional policy files
```

The structure mirrors the live Paperclip layout under
`~/.paperclip/instances/default/companies/{companyId}/agents/{agentId}/instructions/`.

Paperclip's `instructionsBundleMode: "managed"` reads files directly off disk —
it does **not** support a git-backed source. The sync script bridges that gap.

## Edit -> commit -> sync

1. Edit the file under `agent-config/companies/.../instructions/` (this fork).
2. Commit and push to `assaph3004/paperclip` master.
   - **No PRs** to any paperclip repo (fork or upstream) per board direction (2026-05-08).
3. On every machine running agents, pull the fork and run the sync script:

   ```powershell
   pwsh ./agent-config/sync.ps1 -Pull
   ```

   ```bash
   ./agent-config/sync.sh --pull
   ```

   Add `-DryRun` / `--dry-run` first if you want to preview.

4. Live agents pick up the new instructions on the next heartbeat — no restart
   needed because Paperclip re-reads instruction files per run.

## Adding or removing an agent

1. Create or delete the agent in Paperclip as normal.
2. Update `manifest.json` to add/remove the entry (id, name, role, urlKey).
3. For a new agent, create
   `companies/{companyId}/agents/{agentId}/instructions/AGENTS.md`
   (and any other policy files).
4. Commit and run sync.

If you want sync to *delete* live files that are no longer in agent-config
(e.g. after removing `TOOLS.md` from one agent), pass `-Mirror` / `--mirror`.
Without that flag, sync only adds and updates — never deletes — to avoid
surprises.

## Edits made directly on a live machine

If someone edits a live `instructions/` file without going through the fork,
the next sync run will overwrite it. To rescue local edits before syncing:

```powershell
diff (Get-Content path\in\live\instructions.md) (Get-Content path\in\agent-config\instructions.md)
```

Either copy the live edits back into agent-config and commit, or discard them.
Treat agent-config as the source of truth.

## Why not Paperclip-native git support?

`server/src/services/agent-instructions.ts` resolves the bundle from a local
directory only (`resolveManagedInstructionsRoot`). Adding a git remote source
would be an upstream change to paperclip itself — out of scope for ALL-546 and
blocked by the no-PR-to-paperclip rule. A sync script keeps the change inside
this fork.
