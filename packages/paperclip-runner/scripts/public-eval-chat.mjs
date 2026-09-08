// Public replay is a new DTO, never a recursive copy of a provider artifact.
export const PUBLIC_CHAT_SCHEMA =
  "paperclip.runner-protocol-eval.public-chat/v1";
export const PUBLIC_CHAT_NOTICE =
  "Public replay of an isolated mock eval. Conversation text is scrubbed; provider identities, tool payloads, traces, and company-state snapshots are withheld. Full evidence remains in the access-controlled Actions artifact.";

export const SECRET_TEXT = [
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu,
  /\bsk-[A-Za-z0-9_-]{16,}\b/gu,
  /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{16,}\b/gu,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}=*/giu,
  /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gu,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu,
  /\b(?:https?|file|s3):\/\/[^\s<>"')]+/giu,
  /\barn:aws[^\s<>"')]+/gu,
  /(?:\/(?:Users|home|tmp|private|var)\/|[A-Z]:\\)[^\s<>"')]+/gu,
  /\b(?:api[_-]?key|access[_-]?token|secret|password|authorization|cookie)\s*[=:]\s*[^\s,;]+/giu,
];

export function publicText(value, privateValues = []) {
  let text = typeof value === "string" ? value : "";
  for (const secret of privateValues) {
    if (typeof secret === "string" && secret.length >= 8)
      text = text.replaceAll(secret, "[redacted]");
  }
  for (const pattern of SECRET_TEXT) text = text.replace(pattern, "[redacted]");
  return text.length > 40_000 ? `${text.slice(0, 40_000)}\n[truncated]` : text;
}

function privateIdentities(value, found = new Set()) {
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (
        /(?:session|profile|account|runtime|endpoint|memory|agentversion).*id$|arn$|token$|secret$|password$/i.test(
          key,
        ) &&
        typeof child === "string"
      )
        found.add(child);
      else if (child && typeof child === "object")
        privateIdentities(child, found);
    }
  }
  return [...found];
}

function timestamp(value) {
  return typeof value === "string" && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(value)
    ? value
    : "1970-01-01T00:00:00.000Z";
}

function operation(value) {
  return typeof value === "string" && /^[a-z][a-z_]{0,79}$/.test(value)
    ? value
    : "unknown_operation";
}

export function publicChatView(artifact, evalCase) {
  const privateValues = privateIdentities(artifact);
  const scrub = (value) => publicText(value, privateValues);
  const network = artifact.snapshot?.networkEvidence;
  // Only the dedicated mock eval boundary can publish recorded conversation.
  // Early infrastructure failures still receive a viewer with an honest notice.
  const isolated =
    network?.realPaperclipRequests === 0 &&
    Array.isArray(network?.childPaperclipEnvironmentKeys) &&
    network.childPaperclipEnvironmentKeys.length === 0;
  const source =
    isolated &&
    artifact.issueThread?.schema === "paperclip.capability.issue-thread-view.v1"
      ? artifact.issueThread
      : null;
  const evidence = Object.fromEntries(
    [
      "tools",
      "calls",
      "authorization",
      "control_plane",
      "runner",
      "state",
      "traceability",
      "parity",
    ].map((key) => [key, []]),
  );
  const turns = (source?.turns ?? []).map((turn, turnIndex) => {
    const turnId = `public-turn-${turnIndex + 1}`;
    const items = [];
    for (const item of turn.items ?? []) {
      const base = {
        id: `public-item-${turnIndex + 1}-${items.length + 1}`,
        at: timestamp(item.at),
      };
      if (
        ["user_message", "agent_message", "durable_comment"].includes(item.kind)
      ) {
        items.push({
          ...base,
          kind: item.kind === "user_message" ? "user_message" : "agent_message",
          author: item.kind === "user_message" ? "You (eval prompt)" : "Agent",
          body: scrub(item.body),
          streaming: false,
        });
      } else if (item.kind === "tool_activity") {
        const operationId = operation(item.operationId);
        const status = ["ok", "denied", "running"].includes(item.status)
          ? item.status
          : "running";
        const result = {
          outcome: status,
          detail: "Tool payload withheld from public replay.",
        };
        const recordId = `public-call-${turnIndex + 1}-${items.length + 1}`;
        items.push({
          ...base,
          kind: "tool_activity",
          operationId,
          status,
          summary: `${operationId}: ${status}`,
          input: { detail: "Arguments withheld from public replay." },
          result,
          evidenceRef: { section: "calls", recordId },
        });
        if (status !== "running")
          evidence.calls.push({
            id: recordId,
            turnId,
            operationId,
            version: 1,
            providerRequest: operationId,
            dispatchedCommand: operationId,
            outcome: status,
            result,
            redactions: ["arguments", "result payload", "provider identities"],
            threadAnchorId: base.id,
          });
      }
      // Provider activity, reasoning, raw events, file refs and unrecognized
      // future item kinds are deliberately not part of the public contract.
    }
    return {
      id: turnId,
      ordinal: turnIndex + 1,
      mode: "replay",
      toolCallCount: items.filter((item) => item.kind === "tool_activity")
        .length,
      at: timestamp(turn.at),
      stoppedByUser: turn.stoppedByUser === true,
      items,
    };
  });
  if (!turns.some((turn) => turn.items.length > 0)) {
    turns.length = 0;
    turns.push({
      id: "public-turn-1",
      ordinal: 1,
      mode: "replay",
      toolCallCount: 0,
      at: timestamp(artifact.snapshot?.createdAt),
      stoppedByUser: false,
      items: [
        {
          id: "public-notice",
          at: timestamp(artifact.snapshot?.createdAt),
          kind: "system_notice",
          glyph: "–",
          text: "No publishable conversation was recorded for this attempt. See the checks and the access-controlled artifact for diagnostics.",
          evidenceRef: { section: "runner", recordId: "public-notice" },
        },
      ],
    });
  }
  return {
    schema: "paperclip.capability.issue-thread-view.v1",
    sessionId: "public-report",
    mode: "replay",
    identity: {
      agentLabel: "Recorded agent",
      runnerLabel: "Recorded runner",
      runnerAttached: false,
      controlPlaneLabel: "Mock Paperclip",
      controlPlaneTooltip: PUBLIC_CHAT_NOTICE,
      replaySource: "live",
    },
    issue: {
      identifier: "EVAL",
      title: scrub(evalCase.title || evalCase.id),
      status: [
        "backlog",
        "todo",
        "in_progress",
        "in_review",
        "done",
        "blocked",
        "cancelled",
      ].includes(source?.issue?.status)
        ? source.issue.status
        : "in_review",
      priority: "medium",
      assignee: null,
      runState: "Read-only public replay",
      scenarioId: evalCase.id,
      fixtureProfile: evalCase.id,
    },
    turns,
    composer: {
      state: "disabled",
      helper: null,
      reason: "Read-only eval report",
      pendingInteractionId: null,
    },
    evidence,
    connection: { state: "closed", attempt: 0 },
    replay: null,
    renderedAt: timestamp(source?.renderedAt || artifact.snapshot?.createdAt),
  };
}
