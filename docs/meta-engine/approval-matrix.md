# Approval Matrix

Status: Active policy
Version: 0.1
Last updated: 2026-03-14

This matrix defines what agents can do autonomously vs. what requires human approval.
The Policy Engine enforces this at runtime.

---

## Risk Tiers

| Tier | Label | Description |
|------|-------|-------------|
| T0 | Auto | Agent can proceed without notification |
| T1 | Notify | Agent proceeds but logs + notifies human |
| T2 | Approve | Agent must pause and wait for human approval |
| T3 | Blocked | Never permitted without explicit human instruction |

---

## Action Matrix

### Reading and Analysis

| Action | Tier | Notes |
|--------|------|-------|
| Read internal documents (uploaded by customer) | T0 | Core workflow |
| Read control frameworks | T0 | Core workflow |
| Search indexed evidence | T0 | Core workflow |
| Read Paperclip task context | T0 | Normal operation |
| Run eval test cases | T0 | Safe, no side effects |

### Draft Production

| Action | Tier | Notes |
|--------|------|-------|
| Produce draft report (internal) | T0 | Internal only |
| Submit draft for human review in Paperclip | T1 | Notifies reviewer |
| Apply uncertainty gate and route | T0 | Policy-controlled |
| Produce mechanism performance card | T0 | Internal analysis |

### Communication and Delivery

| Action | Tier | Notes |
|--------|------|-------|
| Send email to customer | T2 | Requires human approval |
| Publish report to customer portal | T2 | Requires human approval |
| Post external-facing content | T2 | Requires human approval |
| Reply to customer inquiry | T2 | Requires human approval |
| Send Slack/Teams message to human team | T1 | Notify, no approval needed |

### Data and Storage

| Action | Tier | Notes |
|--------|------|-------|
| Write trace to telemetry store | T0 | Core operation |
| Write draft to file store | T0 | Internal |
| Modify customer-uploaded documents | T3 | Never |
| Delete any file | T3 | Never without explicit instruction |
| Export data to external system | T2 | Requires approval |

### Financial

| Action | Tier | Notes |
|--------|------|-------|
| Check budget remaining | T0 | Read-only |
| Record cost to Paperclip | T0 | Normal operation |
| Make any purchase | T3 | Never |
| Execute financial transaction | T3 | Never |
| Invoice or charge customer | T3 | Never — handled by humans |

### System and Infrastructure

| Action | Tier | Notes |
|--------|------|-------|
| Read environment variables | T0 | Needed for config |
| Write to local file store | T0 | Scoped to workflow |
| Install new packages | T2 | Requires approval |
| Modify production configuration | T3 | Never |
| Change access controls or permissions | T3 | Never |
| Create new accounts or identities | T3 | Never |
| Modify governance rules | T3 | Never |

### Agent Operations

| Action | Tier | Notes |
|--------|------|-------|
| Check out an issue from Paperclip | T0 | Normal heartbeat |
| Mark issue complete | T0 | Normal operation |
| Create sub-issue | T1 | Notify, proceed |
| Assign issue to another agent | T1 | Notify, proceed |
| Create a new agent or role | T2 | Requires approval |
| Disable or remove an agent | T2 | Requires approval |
| Launch a new business workflow | T2 | Requires approval |

### Self-Modification

| Action | Tier | Notes |
|--------|------|-------|
| Propose changes to own prompts | T2 | Requires approval |
| Propose changes to policy engine | T2 | Requires approval |
| Propose changes to doctrine | T2 | Requires approval + quorum |
| Apply changes to doctrine | T3 | Never without human governor action |

---

## Escalation Routing

When an action requires T2 approval:

1. Agent pauses execution
2. Creates Paperclip approval request with:
   - Action description
   - Reason the action is needed
   - Risk assessment
   - Recommended decision
3. Notifies assigned human governor
4. Waits — does not time out or auto-approve
5. On approval: proceeds and logs
6. On rejection: logs, adjusts plan, continues without the action

When a T3 action is attempted:
1. Action is blocked immediately
2. Block is logged in telemetry
3. Human governor is notified
4. Agent reports block and explains what it was trying to do and why

---

## Uncertainty-Specific Escalation

In the Compliance Operator workflow, escalation is also triggered by low confidence:

| Confidence | Decision |
|-----------|---------|
| >= 0.75 with at least 1 citation | PROCEED (T0) |
| 0.40 – 0.74 | VERIFY (route to QA Agent, T1) |
| < 0.40 or no citation | ESCALATE to human (T2) |

This is enforced by the Policy Engine independently of the action-level tiers above.
