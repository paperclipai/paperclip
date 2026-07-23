---
name: site-log-audit
description: Use when auditing WordPress wpdev logs for one or every local site. Group redacted error signatures, match them to Paperclip issues, and file only untreated actionable findings.
version: 1.0.2
author: ClawTeam Engineering
license: MIT
metadata:
  hermes:
    tags: [wordpress, wpdev, logs, qa, paperclip]
    related_skills: [systematic-debugging]
---

# Site Log Audit

Use for one-site incidents, recurring QA log sweeps, or pre-release checks across every wpdev site.

## Rules

- Read-only. Never truncate, rotate, delete, or mutate logs during audit.
- Treat `wp-content/debug.log`, OpenLiteSpeed `<site>-error.log`, and `<site>-access.log` as separate evidence streams. Counts can overlap.
- Redact nonces, tokens, keys, cookies, credentials, and request bodies before storing evidence.
- A historical line is not proof of current failure. Record timestamp, release path, recurrence, and a fresh read-only probe.
- Search Paperclip before filing. Link exact issue identifiers for known signatures.
- File only actionable unmatched findings. Group one root cause per issue; do not create one issue per repeated line.
- QA must review code/site changes. DevOps must approve integration, default-branch push, release, or deployment.

## Run

From this skill directory:

```bash
python3 scripts/audit_logs.py --root /home/agents/workspaces/wordpress --site best-matcha > audit.json
python3 scripts/audit_logs.py --root /home/agents/workspaces/wordpress > all-sites-audit.json
```

Optional lower bound:

```bash
python3 scripts/audit_logs.py --root /home/agents/workspaces/wordpress --since 2026-07-21T00:00:00Z
```

`--site` may repeat. With no `--site`, script discovers every directory under `sites/` and every `<site>-error.log`/`<site>-access.log` pair.

## Procedure

1. Capture immutable context: audit UTC time, site, log paths, byte/line counts, first/last timestamps, active release target, and current health probe.
2. Run `audit_logs.py`. Review grouped signatures by severity, count, first/last timestamp, source files, and redacted samples.
3. Separate:
   - current actionable defect;
   - known issue (open or fixed but stale in retained logs);
   - expected/benign request outcome;
   - historical one-off with no recurrence;
   - secondary symptom caused by another fatal or test load.
4. For each plausible defect, search Paperclip using stable tokens: exception/function, file basename, route, DB constraint/table, or error text. Broad title-only searches are insufficient; inspect issue descriptions/comments.
5. Run smallest read-only reproduction. Never clear logs to manufacture a clean baseline. Compare line count before/after probe instead.
6. Create one implementation issue for each unmatched root cause. Bind active project and owner, then configure QA Engineer review followed by DevOps Engineer approval. Include reproduction, timestamps/counts, source path, acceptance checks, and exactly one named next action.
7. Report known issue mappings, new issue identifiers, deferred historical noise, and unresolved access gaps.

Completion: every grouped signature has one disposition, every new defect has one issue, and no stored sample contains a secret.

## Access-log interpretation

- Treat authenticated `400`, `403`, and expected `404` responses as defects only when request contract says success.
- Group route shape, not secrets or request-specific IDs.
- Old immutable-release URLs can remain in retained access logs after a fixed deployment. Check active symlink and fresh HTML before filing.
- Source-map `404`s are usually non-blocking unless release policy requires maps.

## Verification

```bash
python3 scripts/test_audit_logs.py
```

Pass requires multi-site discovery, signature grouping, HTTP status grouping, URL-userinfo redaction, encoded/semicolon query-secret redaction in access/error logs, and fail-closed handling of malformed request targets.

## Common pitfalls

1. Clearing logs before audit destroys history. Compare line counts around a fresh probe instead.
2. Treating retained failures as current defects duplicates fixed work. Prove current release and recurrence.
3. Searching only issue titles misses mapped defects. Search descriptions/comments with stable signature tokens.
4. Syncing one skill onto an agent with a replacement API can drop existing desired skills. Read current desired set, append this skill, then sync full set.

## Output contract

JSON object:

- `generated_at`, `root`, `sites`
- `files`: path, size, lines, first/last timestamp
- `events`: site, kind, severity/status, normalized signature, count, first/last timestamp, source files, redacted samples

Script classifies evidence, not ownership. Human/agent audit still decides known versus untreated through Paperclip search and current reproduction.
