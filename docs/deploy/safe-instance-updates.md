---
title: Safe Instance Updates
summary: Update a running Paperclip host without mutating it from inside an agent run
---

# Safe Instance Updates

Paperclip agents run inside the same control plane they operate. An agent must not
patch, rebuild, rename, restart, or otherwise mutate the live Paperclip checkout
that is currently serving the board. Treat the running host as read-only from
inside Paperclip.

Use this update path for self-hosted instances that need agent-authored fixes
without requiring a board member to merge a pull request or type terminal
commands.

## Control Boundaries

| Actor | Allowed | Not allowed |
| --- | --- | --- |
| Paperclip agent | Create a branch, edit source in an isolated worktree, run focused checks, open or update a pull request, request review, and record verification. | Edit the live checkout, write build output used by the running server, restart the running server, or push from adapter/runtime execution code. |
| GitHub automation | Run PR checks, enforce required review/status policies, auto-merge eligible pull requests, publish canary/stable packages, and emit release artifacts. | Execute pull request code in privileged `pull_request_target` workflows. |
| Host updater | Watch for approved releases or signed artifacts, stop the old process, install the new artifact into a new versioned directory, swap the service target, run migrations, start the new process, and roll back if health checks fail. | Accept direct shell commands from a Paperclip agent run or mutate the host from inside the live Paperclip process. |

## Recommended Flow

1. An agent makes the source change in an isolated worktree and opens a pull
   request against the deployment repository.
2. PR automation runs required checks and the repository's review policy.
3. When the PR is approved and green, GitHub auto-merge lands it to the release
   branch. The board member is approving policy, not manually merging or running
   host commands.
4. The release workflow publishes a canary or stable artifact from the merged
   commit.
5. An external host updater, installed as a system service outside Paperclip,
   detects the approved artifact and performs the deployment.
6. The updater posts the deployment result back to Paperclip through the API,
   including the version, commit, health-check result, and rollback status.

This keeps each trust boundary narrow: Paperclip can coordinate the work, GitHub
can decide whether the code is allowed to ship, and only the host updater can
change the live host.

## Host Updater Contract

The updater should run under the host operator account, not as a Paperclip agent.
It should use an allowlist of repository, branch, workflow, and artifact names.

Minimum behavior:

- poll or receive a webhook for merged, green commits on the configured release
  branch;
- download only GitHub-produced release artifacts or npm packages matching the
  expected repository and version;
- verify the artifact identity before install;
- install into a new versioned directory instead of overwriting the running
  directory;
- run database migrations from the new version before traffic is switched;
- switch the service manager target and restart the service outside the live
  Paperclip process;
- run a health check against `/api/health`;
- roll back to the previous version if install, migration, start, or health
  check fails;
- write a deployment record back to the issue or deployment log through the
  Paperclip API.

The updater must never execute arbitrary commands supplied by an issue comment,
agent transcript, or pull request body.

## Emergency Fixes

Emergency fixes use the same path with a narrower verification scope and an
explicit emergency label or approval rule. Do not bypass the host updater by
editing the live checkout from an agent run.

