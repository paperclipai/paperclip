# PRA-921 — Discord Community Plan (Prep Document)
**Status**: Pre-positioned — pending PRA-936 unblock
**Owner**: COO
**Created**: 2026-08-19 ~07:00 UTC

## Channel Structure

### Public Channels
| Channel | Purpose |
|---------|---------|
| #welcome | Onboarding guide, rules, roles |
| #general | Open discussion |
| #product-feedback | Beta user feedback collection |
| #showcase | User demos, integrations |
| #support | Bug reports, help requests |
| #announcements | Release notes, updates (mod-only) |

### Internal/Team Channels (Paperclip crew)
| Channel | Purpose |
|---------|---------|
| #ops | Internal coordination |
| #beta-candidates | Candidate pipeline tracking |

## Moderation Guidelines

### Core Rules
1. **Be constructive** — No spam, harassment, or self-promotion without approval
2. **Stay on topic** — Server is for Paperclip AI agent platform discussion
3. **No sharing of sensitive data** — Do not post credentials, API keys, or PII
4. **Report bugs** — Use #support with template: environment, steps, expected vs actual
5. **Respect privacy** — Beta features under NDA stay in private channels

### Roles
| Role | Permissions |
|------|------------|
| @Admin | Full control |
| @Mod | Message management, member management |
| @Beta-Tester | Access to beta channels, can post feedback |
| @Contributor | Trusted community members (promoted by mods) |
| @Member | Default role |

## Onboarding Flow
1. User joins → reads #welcome → accepts rules → gets @Member role
2. Pinned post: "Welcome to Paperclip — your AI agent company platform"
3. Link to quickstart guide (PRA-911) and onboarding docs (PRA-910)
4. Link to GitHub repo / docs site
5. Post in #introduce-yourself (optional)

## Bot Integration (Future)
- Auto-moderation: Discord built-in AutoMod for spam/filtering
- Feedback bot: Lightweight form in #product-feedback
- Status bot: GitHub release notifications → #announcements

## Launch Checklist
- [ ] Create server (or use existing Paperclip server)
- [ ] Configure channels per structure above
- [ ] Set up moderation roles and permissions
- [ ] Write #welcome with rules + onboarding
- [ ] Create invite link with expiry
- [ ] Share with beta candidates from PRA-936 list
- [ ] Post launch in relevant communities (HN, AI agent forums)
- [ ] First-week moderation sweep
