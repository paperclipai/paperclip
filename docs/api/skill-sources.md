---
title: Skill Sources
summary: Import skills from GitHub repositories and approve files the security check flagged
---

A skill source tracks one GitHub repository and branch and installs the skills
it contains. Every endpoint checks company access. Importing, editing, and
updating skills also go through the company skill policy actions described in
the [company skill policy](https://github.com/paperclipai/paperclip/blob/master/doc/company-skill-policy.md).

| Method | Path | Result |
|--------|------|--------|
| GET | `/api/companies/{companyId}/skill-sources` | Sources the caller can see |
| POST | `/api/companies/{companyId}/skill-sources/discover` | Scan a repository without saving anything |
| POST | `/api/companies/{companyId}/skill-sources/preview` | One scanned file |
| POST | `/api/companies/{companyId}/skill-sources` | Create a source and install its selected skills |
| GET | `/api/companies/{companyId}/skill-sources/{sourceId}` | One source |
| PATCH | `/api/companies/{companyId}/skill-sources/{sourceId}` | Change the selected skills, refresh, and change the approval |
| PATCH | `/api/companies/{companyId}/skill-sources/{sourceId}/settings` | Automatic updates, new skills, connection, and tracked branch |
| POST | `/api/companies/{companyId}/skill-sources/{sourceId}/refresh` | Refresh the source now |
| DELETE | `/api/companies/{companyId}/skill-sources/{sourceId}` | Disconnect the source |

## Discovery

`POST /discover` takes `repositoryUrl`, and optionally `packageMode`
(`skills` or `repository`), `trackingRef`, and `connectionId`. It needs the
`skills.import` policy action for the repository. Send
`Accept: application/x-ndjson` to receive progress events, followed by a
`complete` event with the result.

To scan a saved source again, send its `sourceId`. The scan then uses the
repository the source stores, and needs the `skills.edit` action for that
source instead of `skills.import`.

The result lists `securityFindings`: one entry per flagged file, with its
repository `path`, the finding `code` and `message`, the `sha256` of the exact
bytes at the scanned commit, and `overridable`. `canOverrideSecurity` is true
when the caller may approve or withdraw an approval for this repository.

## Approving flagged files

The security check leaves out every file with a finding. A company administrator
can include a file whose only findings are overridable, currently
`remote_fetch_exec` (fetch-and-execute and dynamic execution patterns).
Credential exfiltration, path escapes, symlinks, and other findings can never
be approved.

Send the approval as `securityOverride` when creating a source (`POST`) or
changing its selection (`PATCH`):

| Field | Type | Meaning |
|-------|------|---------|
| `commitSha` | string | The 40-character commit the administrator reviewed |
| `files` | array | `{ path, sha256 }` for each approved file, from the scan; 1 to 10,000 unique paths |
| `reason` | string | Why the repository is trusted; 10 to 2,000 characters |
| `trustFutureUpdates` | boolean | Keep including the same paths in later commits of the reviewed branch; default `false` |
| `reviewedRef` | string | The branch the scan resolved for the reviewed commit (the scan's `trackingRef`); required when `trustFutureUpdates` is `true` |

The paths together may take at most 4 MiB as JSON sends them, so one approval
fits inside the request body limit.

Approving needs a board user who is a company `owner` or `admin`, an instance
administrator, or the local implicit board, and the `skills.override_security`
policy action for the repository. Legacy broad skill grants do not cover this
action. Agent credentials cannot approve. A denied request returns `403` with
code `skill_security_override_denied`.

The server scans the reviewed commit again before saving. It returns:

- `409` with code `skill_security_override_stale` when the commit or a file's
  bytes changed after the review, or when `trustFutureUpdates` is set and the
  source now resolves to a branch other than `reviewedRef` (for example, a
  source that tracks `HEAD` after the repository changed its default branch).
- `422` with code `skill_security_override_stale` when a listed file is not
  flagged at that commit.
- `422` with code `skill_security_override_forbidden` when a listed file also has
  a finding that can never be approved.

On `PATCH`, a new `securityOverride` replaces the saved approval, and the update
publishes exactly the files that approval admits. `securityOverride: null`
withdraws the saved approval; it needs the same administrator permission.
Leaving the field out keeps the saved approval.

## How an approval applies

Without `trustFutureUpdates`, an approval covers the reviewed commit only. A
later commit leaves the files out again until an administrator approves it. With
`trustFutureUpdates`, refreshes keep including the approved paths in later
commits of the branch the administrator reviewed. That trust ends when the
source's `trackingRef` changes, or when a source that tracks `HEAD` resolves to a
different default branch. The approval then covers its reviewed commit only.

Each installed skill version keeps the approval that admitted its files.
Audits, update diffs, and file previews of that version use its own record, so
renewing, narrowing, or withdrawing the source approval does not change how an
installed version is judged.

Source responses include `securityOverride` as a summary: the reviewed
`commitSha` and branch, the reason, `trustFutureUpdates`, the approver and time,
and `fileCount`. The approved file list stays on the server.

The activity log records `company.skill_source_security_override_approved` for
a new approval, `company.skill_source_security_override_applied` when a refresh
includes approved files from a later commit, and
`company.skill_source_security_override_revoked` when an approval is withdrawn or
its future-update trust ends.
