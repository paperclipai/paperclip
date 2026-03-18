# Gearment instance access audit

Date: 2026-03-18

This note captures the current access state of the local Gearment Paperclip instance running at `https://paperclip.doremon.app`.

## Deployment facts

- Deployment mode: `authenticated`
- Public URL: `https://paperclip.doremon.app`
- Local server: `127.0.0.1:3100`
- Database: `postgres://paperclip:***@localhost:5432/paperclip`

## Current human users

Total rows in `"user"`: `5`

| Name | Email | Verified | Created |
|------|-------|----------|---------|
| Board | `local@paperclip.local` | yes | 2026-03-16 |
| Terry Le | `tonle@gearment.com` | yes | 2026-03-16 |
| Phuong Nguyen | `phuongnguyen@gearment.com` | yes | 2026-03-17 |
| Sung Jinwoo | `trungnt@gearment.com` | yes | 2026-03-17 |
| Khanh | `khanhnguyen@gearment.com` | no | 2026-03-18 |

## Company memberships

Current `company_memberships` rows for `Gearment Inc`:

- `local-board` — `user`, `owner`, `active`
- `Terry Le` — `user`, `owner`, `active`
- `Doremon` agent — `member`, `active`
- one additional `agent` row with malformed `principal_id` containing `INSERT 0 1`

## Instance-wide admin roles

Current `instance_user_roles`:

- Khanh — `instance_admin`
- Phuong Nguyen — `instance_admin`
- Terry Le — `instance_admin`

## Explicit permission grants

Current `principal_permission_grants` rows:

- `Doremon` agent — `tasks:assign`

No explicit user-level grants were present at audit time.

## Effective access differences

There are currently three distinct access classes:

1. `instance_admin`
   - Full board-level access across companies via override
   - Current users: Terry Le, Phuong Nguyen, Khanh

2. company member with no instance admin
   - Access depends on active company membership plus explicit company-scoped grants
   - Current example: `local-board` is an owner member of `Gearment Inc`

3. user with no current access
   - No instance admin role and no active company membership
   - Current example: Sung Jinwoo

## Agent identity check

The claimed API key in the local workspace resolved to:

- Agent: `Doremon`
- Status: `idle`
- Visible permission flags: `canCreateAgents: false`

## Findings

- `instance_admin` is currently broader than company membership and bypasses company-scoped permission checks.
- There are no explicit human permission grants in `principal_permission_grants`; human access is currently dominated by instance admin plus company membership.
- One `company_memberships` row appears malformed because the `principal_id` contains `INSERT 0 1`. That should be cleaned up and root-caused before relying on agent membership data for authorization or reporting.
