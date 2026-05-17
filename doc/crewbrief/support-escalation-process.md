# CrewBrief — Support Escalation & Feedback Process

**Version:** 1.0
**Owner:** Sydney, Director of Customer Success
**Status:** Active

## Support Channels

| Channel | Address | Best For |
|---|---|---|
| Email | help@crewbrief.com | All inquiries |
| In-app | Help menu → Contact (when available) | Urgent issues |
| Feedback | In-app → Feedback (when available) | Feature requests, suggestions |

## SLA Tiers

| Tier | Definition | Response Time | Examples |
|---|---|---|---|
| P0 — Critical | Service down, data loss, safety impact | < 15 min | Briefing delivery failure, incorrect weather data |
| P1 — High | Major feature broken, no workaround | < 1 hour | Cannot schedule briefing, app crash on open |
| P2 — Medium | Feature impaired, workaround exists | < 4 hours | Slow loading, missing optional data field |
| P3 — Low | Cosmetic, enhancement request | < 24 hours | UI polish, feature request, question |

## Escalation Path

```
User submits issue (email / in-app)
        │
        ▼
  Sydney (Customer Success) triages
  - Acknowledges receipt within SLA
  - Determines tier and owner
        │
        ├── P0/P1 (bugs, infra, technical) ──► Hunter (CTO)
        │     Sydney creates child issue with:
        │     - Full reproduction steps
        │     - User impact assessment
        │     - Priority justification
        │     - User contact info
        │     Sydney follows up with user on resolution
        │
        ├── P2/P3 (UX, feature requests) ──► Penny (Product)
        │     Sydney logs in issue tracker
        │     Penny prioritizes for roadmap
        │     Sydney communicates timeline to user
        │
        └── Customer success (onboarding, questions) ──► Sydney handles
              - Direct response
              - Knowledge base update if recurring
```

## Feedback Collection

### Intake Template

When collecting user feedback, capture:

```
User: [email or identifier]
Date: [date]
Channel: [email / in-app / survey / interview]

Type:
  [ ] Bug / technical issue
  [ ] Feature request
  [ ] Usability problem
  [ ] General feedback
  [ ] Praise / positive

Description:
[Detailed description]

Severity (user-reported):
  [ ] Blocking — cannot complete task
  [ ] Major — significantly impeded
  [ ] Minor — slight inconvenience
  [ ] Suggestion — nice to have

Product area:
  [ ] Signup / onboarding
  [ ] Briefing delivery
  [ ] Briefing content
  [ ] Schedule / calendar
  [ ] Profile / settings
  [ ] Notifications
  [ ] Other: ______________

User expectations:
[What did the user expect to happen?]

Attachments:
[Screenshots, logs, or recordings]
```

### Automated Feedback Touchpoints

| Trigger | Method | Frequency |
|---|---|---|
| After 5th briefing | In-app NPS prompt | Once |
| After support ticket closed | CSAT survey | Per ticket |
| On account cancellation | Exit survey | Once |
| Inactivity > 14 days | Re-engagement email | Automated |
| Quarterly | User interviews | Quarterly |

## Churn Prevention Signals

| Signal | Action |
|---|---|
| No briefing scheduled in 14 days | Send re-engagement email with tips |
| No login in 30 days | Personal check-in from Sydney |
| Repeated support tickets (3+ in 30 days) | Escalation review with Hunter/Penny |
| Failed briefing delivery (2+ consecutive) | Auto-create P1 bug to Hunter |
| Negative NPS/CSAT score | Personal follow-up within 24h |

## Escalation Templates

### Bug Report to Hunter

```
Subject: [P0/P1] User bug: [short description]

User: [email]
Impact: [how many users affected, blocking status]
SLA tier: [P0/P1]

Description:
[Full description]

Steps to reproduce:
1. [step]
2. [step]
3. [step]

Expected vs actual:
Expected: [what should happen]
Actual: [what actually happens]

Environment: [app version, device, OS]
Attachments: [links]

Sydney follow-up: [who to notify on resolution]
```

### Feature Request to Penny

```
Subject: Feature request: [feature name]

User: [email]
Use case: [what the user is trying to do]
Current workaround: [if any]
Priority (user): [blocking/major/minor/suggestion]

Description:
[Detailed description of requested feature]

Expected benefit:
[how this improves the user's workflow]
```

## Reporting Cadence

| Report | Frequency | Audience | Content |
|---|---|---|---|
| Support snapshot | Weekly | Sydney | Tickets by tier, resolution times, trends |
| Feedback digest | Bi-weekly | Sydney, Penny, Miles | Top themes, feature requests, NPS trend |
| Churn report | Monthly | Sydney, Grace | Churn rate, at-risk users, intervention results |
| Executive summary | Monthly | Miles | Customer health, SLA compliance, escalations |
