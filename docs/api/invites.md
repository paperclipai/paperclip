---
title: Invites API
summary: Company member invitations with role-based access
version: v0.5.0
last_updated: 2026-08-21
---

# Invites API

The Invites API allows board users to invite others to join a company with specific roles (viewer, operator, admin). Invited users receive a token-based invite link with onboarding data, skill previews, and company branding.

## Endpoints

### List company invites

```
GET /api/companies/{companyId}/invites
```

Returns all invites for a company.

**Authorization:** Board user with company access.

### Create a company invite

```
POST /api/companies/{companyId}/invites
```

Creates a new invite for a user to join the company.

**Request body:**

```json
{
  "email": "collaborator@example.com",
  "name": "Jane Smith",
  "role": "operator",
  "message": "Join our team!"
}
```

**Fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `email` | string | yes | Email address of the person to invite |
| `name` | string | no | Display name for the invite |
| `role` | string | no | Role to assign: `viewer`, `operator`, or `admin` (default: `operator`) |
| `message` | string | no | Personal message included in the invite |

**Authorization:** Board user with `members:invite` permission.

### Get an invite by token

```
GET /api/invites/{token}
```

Returns invite details for a given token. Used by the invite landing page to display company info, role, and message before the user decides to accept.

**Authorization:** Public (no auth required — the token itself is the credential).

### Accept an invite

```
POST /api/invites/{token}/accept
```

Accepts an invite and creates or replays a join request. The authenticated user becomes a member of the company with the role specified in the invite.

**Request body:**

```json
{
  "name": "Jane Smith"
}
```

**Fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Display name to use for the new membership |

**Authorization:** Authenticated user with a valid session.

### Revoke an invite

```
POST /api/invites/{inviteId}/revoke
```

Revokes an outstanding invite. The invite token will no longer be valid for acceptance.

**Authorization:** Board user with `members:invite` permission.

### Get invite onboarding data

```
GET /api/invites/{token}/onboarding
```

Returns onboarding data associated with the invite, including company context and initial setup information for the invited user.

**Authorization:** Public (token-based access).

### Get invite onboarding text

```
GET /api/invites/{token}/onboarding.txt
```

Returns onboarding instructions as plain text. Useful for CLI or non-browser invite flows.

**Authorization:** Public (token-based access).

### Get company logo for invite

```
GET /api/invites/{token}/logo
```

Returns the company's logo image for display on the invite landing page.

**Authorization:** Public (token-based access).

### List skills for invite

```
GET /api/invites/{token}/skills/index
```

Returns the skills index for the company associated with the invite. Lets prospective members preview available agent skills before accepting.

**Authorization:** Public (token-based access).

### Get skill by name for invite

```
GET /api/invites/{token}/skills/{skillName}
```

Returns a specific skill's details. Prospective members can preview individual skills.

**Authorization:** Public (token-based access).

### Test invite token resolution

```
GET /api/invites/{token}/test-resolution
```

Tests whether an invite token resolves to a valid invite. Returns the invite metadata without requiring acceptance. Useful for validating invite links.

**Authorization:** Public (token-based access).

## Related Endpoints

### List company members

```
GET /api/companies/{companyId}/members
```

Returns all current members of a company, including their roles and status.

### Update a company member

```
PATCH /api/companies/{companyId}/members/{memberId}
```

Updates a member's role or status. Supports role changes between viewer, operator, and admin, or member removal.

### Join requests

```
GET /api/companies/{companyId}/join-requests
POST /api/companies/{companyId}/join-requests/{requestId}/approve
POST /api/companies/{companyId}/join-requests/{requestId}/reject
```

Users can request to join a company. Board users can approve or reject pending requests. Join requests are created automatically when an invite is accepted by a user who hasn't yet been processed.

## Role Model

| Role | Permissions |
|------|-------------|
| **Viewer** | Read-only access to company data, agents, and work products. Cannot modify anything. |
| **Operator** | Can perform most operational tasks (create agents, update issues, manage knowledge). Cannot manage billing or invites. |
| **Admin** | Full access including billing, invites, member management, and company settings. |

## Error Responses

| Status | Meaning |
|--------|---------|
| `400` | Bad request — invalid input or expired token |
| `401` | Unauthorized — missing or invalid authentication |
| `403` | Forbidden — insufficient permissions |
| `404` | Not found — invite token doesn't exist or has been revoked |
