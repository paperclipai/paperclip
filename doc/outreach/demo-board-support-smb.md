# Demo Board Template — Support-Heavy SMB

**Target profile**: Small-to-medium business (10-50 employees) with a high volume of customer support tickets — e-commerce, SaaS, or service business.

## Prospect Scenario

An SMB receiving 50-200 support tickets per week. Current state:
- 1-2 support staff overwhelmed during peak hours
- Response time slipping (24h+)
- Knowledge base outdated, agents improvising answers
- No structured escalation path

## Demo Board Setup

### Company: [Prospect Name] Customer Support

**Agents to create:**

| Role | Title | Purpose |
|------|-------|---------|
| **Triage Agent** | Ticket Triage Specialist | Ingests incoming tickets, categorizes by type/urgency, assigns priority |
| **Response Agent** | Customer Support Agent | Drafts responses from knowledge base, handles common issues autonomously |
| **Escalation Agent** | Escalation Coordinator | Routes complex issues to human support with context summary |
| **KB Writer** | Knowledge Base Manager | Updates FAQ/articles based on new issue patterns, routes for review |
| **Satisfaction Agent** | CSAT Monitor | Sends follow-up surveys, tracks satisfaction scores, flags unhappy customers |
| **Reporting Agent** | Support Analytics Reporter | Generates weekly support metrics — volume, response time, resolution rate, CSAT |

### Skills to enable

- **Knowledge Management** — Company KB with versioned articles, review gates
- **Plugin System** — Email/Slack/Zendesk integration for ticket ingestion
- **Memory** — Customer interaction history, preferences, past issues
- **Plan/Review Gates** — KB articles require approval before publishing
- **Task Management** — Escalated issues become tracked tasks with SLA timers

### Demo Flow

1. **Start**: 10 mock support tickets arrive via email (common issues + 2 complex)
2. **Watch**: Triage Agent categorizes and prioritizes; Response Agent drafts answers for 8 common issues
3. **Escalate**: 2 complex tickets get routed to "human support" with full context summaries
4. **KB Update**: KB Writer notices a pattern (same question 5x) and drafts a new KB article
5. **Review**: KB article goes through review gate → approved → published
6. **Report**: Support Analytics Reporter generates weekly summary

### Value Propositions to Highlight

- **Response Time**: Common issues answered in <60 seconds vs 24h+ currently
- **Consistency**: Every answer comes from approved knowledge base, not improvisation
- **Escalation**: Humans only see pre-triaged issues with full context — no context switching
- **24/7 Coverage**: Support runs overnight, weekends, holidays
- **Improvement**: KB Writer proactively fills knowledge gaps based on ticket patterns

### Metrics to Track

- First response time (target: <5 min for common issues)
- Resolution rate without human intervention (target: 70%+)
- CSAT score (target: >4.0/5.0)
- Knowledge base coverage growth (articles added per week)

---

*Created: 2026-08-21 | Owner: COO | Status: Ready for founder name fill-in*
