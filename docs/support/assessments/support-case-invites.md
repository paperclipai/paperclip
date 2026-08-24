---
title: Support Case Assessment — Company Invites (v0.5.0)
summary: Token-based company member invitations with role-based access controls
version: v0.5.0
commit: c68cb0bb3f (E2E test verification)
last_updated: 2026-08-21
---

# Support Case Assessment: Company Invites (v0.5.0)

## Feature Overview

The Company Invites system allows board users to invite external users to join a company with specific roles (viewer, operator, admin). Invites are token-based — each invite generates a unique URL that the recipient can use to accept and join the company. The system includes an invite landing page with company branding, onboarding data, skill previews, and a structured join flow.

### Key capabilities

- **Create invites** — Board users with `members:invite` permission can invite users by email with a specific role
- **Token-based access** — Invite tokens serve as the access credential for the landing page (no login required to view invite details)
- **Role assignment** — Invited users are assigned viewer, operator, or admin role upon acceptance
- **Invite landing page** — Public-facing page with company logo, role preview, onboarding instructions, and skill previews
- **Revocation** — Outstanding invites can be revoked at any time
- **Join requests** — Users can request to join a company; board users approve or reject
- **Member management** — List, update roles, and remove members

### What it does NOT do

- Does not support bulk invite creation (one invite per API call)
- Does not send email notifications (invite links must be shared out-of-band)
- Does not support invite expiration by time (revocation is manual)
- Does not support cross-company memberships (a user is a member of one company at a time for invite purposes)

## Authorization

| Operation | Required Permission |
|-----------|-------------------|
| List invites | Board user with company membership |
| Create invite | `members:invite` permission |
| Revoke invite | `members:invite` permission |
| View invite by token | Public (token is credential) |
| Accept invite | Authenticated user session |
| List members | Board user with company membership |
| Update member role | `members:manage` permission |

## Known Limitations

| Limitation | Description | Workaround |
|------------|-------------|------------|
| No email delivery | Invite links must be shared manually | Share the invite URL via your own email, chat, or other channel |
| No bulk create | Each invite requires a separate API call | Script multiple calls if needed |
| No auto-expiry | Invites remain valid until revoked | Periodically audit and revoke stale invites |
| Single company | A user cannot be a member of multiple companies via invites | Only one active membership per user account |
| Name required on accept | The accepting user must provide a display name | Ensure users provide their preferred name |

## Troubleshooting

### Invite link doesn't work

1. **Verify the token** — Invite tokens are UUIDs. Ensure the full URL was copied correctly (no truncation).
2. **Check if revoked** — An admin may have revoked the invite. Ask the sender to create a new one.
3. **Test the token** — Use `GET /api/invites/{token}/test-resolution` to check if the token is valid without accepting.
4. **Check company exists** — The invite's company may have been deleted. Ask the sender to verify.

### Cannot accept an invite

1. **Authentication required** — The user must be logged in with a valid session before accepting.
2. **Already a member** — If the user is already a member of the company, the invite will fail. Contact an admin to update the existing membership role if needed.
3. **Invalid token** — If the token returns 404, the invite may have been revoked or never existed.

### Role seems wrong after accepting

1. **Check the invite** — The role was set when the invite was created. The sender can check `GET /api/companies/{companyId}/invites`.
2. **Update role** — An admin can update the member's role via `PATCH /api/companies/{companyId}/members/{memberId}`.

### Join request pending

1. If a user accepted an invite but the membership is pending, the join request may need approval.
2. Board users can check pending join requests via `GET /api/companies/{companyId}/join-requests`.
3. Approve or reject the request as appropriate.

## Common Questions

**Q: Can I invite someone without an account?**
A: Yes. The invite link shows company details and onboarding info without requiring login. The user must create an account before accepting the invite.

**Q: Do invite links expire?**
A: Not automatically. Invites remain valid until explicitly revoked. Best practice is to audit and revoke stale invites regularly.

**Q: Can I change someone's role after they've accepted?**
A: Yes. An admin can update any member's role via the member management endpoints.

**Q: What happens if I revoke an invite after someone already accepted?**
A: Revocation only prevents future acceptances using that token. Existing memberships are unaffected. To remove a member, use the member management endpoint.

**Q: Can I preview what skills the company has before accepting?**
A: Yes. The invite landing page includes a skills index (`GET /api/invites/{token}/skills/index`) that prospective members can browse.

## Escalation Path

| Issue | Severity | Action |
|-------|----------|--------|
| Invite accept creates duplicate membership | P2 | Escalate to engineering. Duplicate memberships should not occur — the system detects existing members and returns an error. |
| Invite token collision | P1 | Escalate to engineering. Tokens are UUIDs and should be unique. |
| Join request approval doesn't create membership | P2 | Escalate to engineering. Approval should immediately create the membership. |

## Related Documentation

- API reference: `/api/invites`
- Release notes: `/releases` (v0.5.0 Market Readiness)
- Board operator guide: `/guides/board-operator/creating-a-company`
