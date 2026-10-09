/** Production monitor tool; timers and wake delivery belong to Paperclip. */
const description = "Schedule, replace, or clear a one-shot task monitor. Omit taskId for your current task; other tasks must also be assigned to you and in progress or review. Supply a future nextCheckAt and notes describing the next check, or monitor: null to clear. A successful receipt reports the persisted monitor; a replay reports its current state without re-arming it. After scheduling your current task, end the turn with paperclip_finish: yielded and continuation.kind monitor. Paperclip will wake you with issue_monitor_due; do not sleep, poll, mark done, or use call_api for this wait.";

export const setTaskMonitorInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["idempotencyKey", "monitor"],
  properties: {
    taskId: { type: "string", description: "Owned task UUID. Omit for the active task." },
    idempotencyKey: { type: "string", minLength: 1, maxLength: 240, description: "Reuse with identical arguments on retries." },
    monitor: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["nextCheckAt", "notes"],
      properties: {
        nextCheckAt: { type: "string", description: "Future UTC timestamp for the next check. This is one shot, not a recurring interval." },
        notes: { type: "string", minLength: 1, maxLength: 500, description: "What to check on the next run; do not include secrets." },
        kind: { type: ["string", "null"], enum: ["external_service", null] },
        serviceName: { type: ["string", "null"], minLength: 1, maxLength: 120 },
        externalRef: { type: ["string", "null"], minLength: 1, maxLength: 500 },
        timeoutAt: { type: ["string", "null"], description: "Optional deadline later than nextCheckAt." },
        maxAttempts: { type: ["integer", "null"], minimum: 1, maximum: 100, description: "Optional cumulative attempt limit for this task's monitor." },
        recoveryPolicy: { type: ["string", "null"], enum: ["wake_owner", "create_recovery_issue", "escalate_to_board", null] },
      },
    },
  },
} as const;

export const setTaskMonitorAction = {
  id: "set_task_monitor",
  canonical: {
    operationId: "set_task_monitor", surfaces: ["live"], placement: "optional_agent_tool",
    optionalGroup: "wake_scheduling", requiredClaims: [], taskModes: ["standard"],
    sideEffectClass: "task_write", idempotency: "required", disabledByDefault: false,
    realBindingStatus: "live_codex", realServiceBinding: "prepareIssueMonitorUpdate",
    prpEvidence: "Transactional persisted issue monitor, audit activity and idempotent run receipt.",
    prpBindingStatus: "bound", legacyAliases: [],
  },
  documentation: { title: "Set task monitor", description, note: null },
  examples: {
    call: { operationId: "set_task_monitor", input: { idempotencyKey: "check-ci", monitor: { nextCheckAt: "2030-01-01T12:00:00Z", notes: "Check the pending CI run." } } },
    scenarioCall: null,
    success: { ok: true, operationId: "set_task_monitor", result: { taskId: "task-1", status: "in_progress", monitor: { nextCheckAt: "2030-01-01T12:00:00Z", status: "scheduled" }, replayed: false } },
  },
  live: {
    order: 51,
    descriptor: {
      schema: "paperclip.semantic-tool.v1", operationId: "set_task_monitor", version: 1,
      title: "Set task monitor", description, exposure: "optional", requiredClaims: [],
      allowedModes: ["standard"], inputSchema: setTaskMonitorInputSchema,
      outputSchema: { type: "object", additionalProperties: true },
    },
  },
  scenario: null,
} as const;
