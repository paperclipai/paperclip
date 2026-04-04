---
trigger: model_decision
description: Whenever implementing or modifying service methods that perform mutations
---

# Rule: Activity Logging

Every state-mutating action in Paperclip must be recorded in the `activity_log` to maintain a complete audit trail of agent and human actions.

- **Activation**: `Model Decision` (whenever implementing or modifying service methods that perform mutations)

## Guidelines

- **Comprehensive Coverage**: Any `POST`, `PUT`, `PATCH`, or `DELETE` equivalent in a service must include an `activityLogService.record` call.
- **Contextual Detail**: Log entries should describe *what* changed and *who* changed it (agent ID or board user ID).
- **Redaction**: Never log plain-text secrets or sensitive configuration. Reference the `rule-secret-management.md` or use identifier references.
- **Linkage**: When possible, link activity logs to specific tasks, projects, or companies to allow for contextualized history views.
- **Success Only**: Ensure the activity log entry represents a successful completion of the action (usually committed within the same database transaction).
