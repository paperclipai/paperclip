import { redactCommandText } from "@paperclipai/adapter-utils";

const SECRET_FIELD_NAME_PATTERN = String.raw`[A-Za-z0-9_-]*(?:api[-_]?key|access[-_]?token|auth(?:_?token)?|token|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring|browser[-_]?code|login[-_]?url)[A-Za-z0-9_-]*`;

const SECRET_PAYLOAD_KEY_RE = new RegExp(SECRET_FIELD_NAME_PATTERN, "i");
// Authorization reasons are policy decision codes, not credentials. They must
// remain visible in audit receipts even though the field name contains
// "authorization". JWT-shaped values are still caught by the value guard below.
const AUDIT_REASON_PAYLOAD_KEY_RE = /^authorizationReason$/;
const AUDIT_SURFACE_PAYLOAD_KEY_RE = /^surface$/;
/**
 * Cleanup counts on a connection-removal receipt (PAP-17119). Their names name
 * the thing they counted — secrets, bindings, tokens — so the key guard above
 * would blank the whole receipt and leave the operator unable to see what a
 * revocation actually tore down. They pass only while the value really is a
 * finite number, so nothing that could carry material rides through on the
 * strength of a familiar key name.
 */
const AUDIT_COUNT_PAYLOAD_KEYS = new Set([
  "secretsRevoked",
  "secretsRetainedShared",
  "credentialRefsCleared",
  "secretBindingsRemoved",
  "tokenIssuanceHashesCleared",
  "gatewayTokensRevoked",
  // PRP usage.reported metrics count model tokens; they never carry token
  // credential material. Keep the exemption closed to finite numbers.
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "preTokens",
  "postTokens",
]);

function isAuditCountField(key: string, value: unknown): boolean {
  return (
    AUDIT_COUNT_PAYLOAD_KEYS.has(key) &&
    typeof value === "number" &&
    Number.isFinite(value)
  );
}
const COMMAND_PAYLOAD_KEY_RE =
  /(^command$|^cmd$|command[-_]?line|resolved[-_]?command|PAPERCLIP_RESOLVED_COMMAND)/i;
const COMMAND_ARGS_PAYLOAD_KEY_RE = /^(commandArgs|command_?args|argv)$/i;
const JWT_VALUE_RE =
  /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?$/;
// Durable protocol schema identifiers share JWT's broad dotted shape but are
// public discriminators, not credentials. Exempt the Paperclip schema
// namespace only in fields that actually declare a schema; the same value in
// arbitrary provider data remains subject to the fail-closed JWT guard.
const PAPERCLIP_SCHEMA_FIELDS = new Set(["schema", "runtimeSchema"]);
export const PAPERCLIP_PUBLIC_SCHEMA_IDS = new Set([
  "paperclip.artifact.generated.v1",
  "paperclip.artifact.viewed.v1",
  "paperclip.capability-discovery.v1",
  "paperclip.capability.authorization-record.v1",
  "paperclip.capability.control-plane.v1",
  "paperclip.capability.devtools.v1",
  "paperclip.capability.eval-parity-report.v1",
  "paperclip.capability.exposure.v1",
  "paperclip.capability.issue-thread-view.v1",
  "paperclip.capability.live-session-checkpoint.v1",
  "paperclip.capability.live-session.v1",
  "paperclip.capability.live-smoke.v1",
  "paperclip.capability.mock-export.v1",
  "paperclip.capability.mock-state.v1",
  "paperclip.capability.model-tool-result.v1",
  "paperclip.capability.run-artifact.v1",
  "paperclip.capability.run-context.v1",
  "paperclip.capability.scenario-index.v1",
  "paperclip.capability.scenario-parity.v1",
  "paperclip.capability.semantic-tool-runtime.v1",
  "paperclip.capability.state-diff.v1",
  "paperclip.capability.tool-result.v1",
  "paperclip.capability.turn-stream.v1",
  "paperclip.capability.visible-tools.v1",
  "paperclip.completion-contract.v1",
  "paperclip.context.compacted.v1",
  "paperclip.delegation.v1",
  "paperclip.fake_harness.script.v1",
  "paperclip.hook.v1",
  "paperclip.interaction_request.v1",
  "paperclip.local-provider-boundary-golden.v1",
  "paperclip.memory.citation.v1",
  "paperclip.model.provider_message.v1",
  "paperclip.model.route_changed.v1",
  "paperclip.model.verification.v1",
  "paperclip.native-cancellation.v1",
  "paperclip.native-execution-input.v1",
  "paperclip.native-execution-input.v2",
  "paperclip.native-execution-input.v3",
  "paperclip.native-execution-input.v4",
  "paperclip.native-finalization.v1",
  "paperclip.native-finalization.v2",
  "paperclip.native-harness-backup-stamp.v1",
  "paperclip.native-harness-backup-stamp.v2",
  "paperclip.native-harness-backup.v1",
  "paperclip.native-model-envelope.v1",
  "paperclip.native-model-envelope.v2",
  "paperclip.native-session-scope.v2",
  "paperclip.native-session-supervisor.v1",
  "paperclip.plan.updated.v1",
  "paperclip.provider.native.v1",
  "paperclip.provider.notice.v1",
  "paperclip.provider_trace_frame.v1",
  "paperclip.provider_trace_interpretation.v1",
  "paperclip.provider_trace_metadata.v1",
  "paperclip.prp.capabilities.v1",
  "paperclip.prp.command.v1",
  "paperclip.prp.contract_manifest.v1",
  "paperclip.prp.event.v1",
  "paperclip.prp.fixture.v1",
  "paperclip.prp.identity.v1",
  "paperclip.prp.semantic_tool.v1",
  "paperclip.prp.semantic_tool.v2",
  "paperclip.prp.semantic_tools.v1",
  "paperclip.prp.session-snapshot.v1",
  "paperclip.prp.stop_reason.v1",
  "paperclip.prp.terminal.v1",
  "paperclip.question_adapter_fixture.v1",
  "paperclip.question_response.v1",
  "paperclip.question_response_delivery.v1",
  "paperclip.question_set.v1",
  "paperclip.research.v1",
  "paperclip.review.mode_changed.v1",
  "paperclip.run-performance-span.v1",
  "paperclip.run-result.v1",
  "paperclip.run_presentation_decision.v1",
  "paperclip.run_result.v1",
  "paperclip.runner.acpx-identity.v1",
  "paperclip.runner.acpx-identity.v2",
  "paperclip.runner.authorized-tools.v1",
  "paperclip.runner.codex.metadata.v1",
  "paperclip.runner.codex.trace.v1",
  "paperclip.runner.compatibility.v1",
  "paperclip.runner.conformance.fixture.v1",
  "paperclip.runner.conformance.output.v1",
  "paperclip.runner.durable.control-plane-state.v1",
  "paperclip.runner.durable.diagnostics.v1",
  "paperclip.runner.durable.state.v1",
  "paperclip.runner.durable.trace.v1",
  "paperclip.runner.eval-bundle-evidence.v1",
  "paperclip.runner.eval-bundle.v1",
  "paperclip.runner.eval-scorecard.v1",
  "paperclip.runner.eval-scorecard.v2",
  "paperclip.runner.eval-slice-report.v1",
  "paperclip.runner.live-console.conformance.v1",
  "paperclip.runner.live-eval-candidate.v1",
  "paperclip.runner.live-eval-schedule.v1",
  "paperclip.runner.local-acpx-authority.v1",
  "paperclip.runner.local-runner.metadata.v1",
  "paperclip.runner.local-runner.summary.v1",
  "paperclip.runner.local-runner.trace.v1",
  "paperclip.runner.profile.v1",
  "paperclip.runner.retained_cleanup_failure.v1",
  "paperclip.runner.sanitized-provider-fixture.v1",
  "paperclip.runner.secure-frame.v1",
  "paperclip.runner.standalone.standalone-demo.v1",
  "paperclip.runner.stream.v1",
  "paperclip.runner.stress-eval-traceability.v1",
  "paperclip.runner.workflow-eval-case.v1",
  "paperclip.runner.workflow-eval-report.v1",
  "paperclip.runner.workflow-observation.v1",
  "paperclip.runtime-asset-manifest.v1",
  "paperclip.runtime-asset.v1",
  "paperclip.runtime_request.v1",
  "paperclip.runtime_request.v2",
  "paperclip.safety.review.v1",
  "paperclip.semantic-action.v1",
  "paperclip.semantic-authorization-record.v1",
  "paperclip.semantic-binding.v1",
  "paperclip.semantic-conformance-report.v1",
  "paperclip.semantic-denial.v1",
  "paperclip.semantic-discovery.v1",
  "paperclip.semantic-interaction-result.v1",
  "paperclip.semantic-tool.v1",
  "paperclip.semantic_tool_result.v1",
  "paperclip.semantic_tool_result_chunks.v1",
  "paperclip.skillless_task.v1",
  "paperclip.status-authority-conformance.v1",
  "paperclip.stop_reason.v1",
  "paperclip.tagged_graph.v1",
  "paperclip.task_envelope.v1",
  "paperclip.terminal.input_sent.v1",
  "paperclip.tool.execution.v1",
  "paperclip.wait.v1",
  "paperclip.workspace.diff.v1",
  "paperclip.workspace.file_reference.v1",
  "paperclip.workspace_create_target.v1",
  "paperclip.workspace_entry.v1",
  "paperclip.workspace_relative_display.v2",
]);
// Keep this closed catalog aligned with PRP v1's event.schema.json. These
// values are public protocol discriminators, but their dotted shape overlaps
// the deliberately broad JWT heuristic. They are exempt only in the
// discriminator field of a PRP v1 event envelope; the same string anywhere
// else remains subject to redaction.
export const PRP_V1_EVENT_TYPES = new Set([
  "runner.connected",
  "runner.reconnected",
  "runner.reconciled",
  "runner.disconnected",
  "runner.draining",
  "runner.backpressure",
  "runner.suspending",
  "runner.suspended",
  "runner.stopped",
  "runner.diagnostic",
  "runtime.phase.changed",
  "sandbox.metric",
  "workspace.ready",
  "workspace.change.updated",
  "workspace.diff.recorded",
  "workspace.file.referenced",
  "harness.starting",
  "harness.ready",
  "harness.exited",
  "harness.diagnostic",
  "plan.updated",
  "tool.execution.started",
  "tool.execution.progressed",
  "tool.execution.completed",
  "research.started",
  "research.progressed",
  "research.completed",
  "delegation.started",
  "delegation.updated",
  "delegation.completed",
  "model.route.changed",
  "model.verification.updated",
  "context.compacted",
  "artifact.viewed",
  "artifact.generated",
  "review.mode.changed",
  "hook.started",
  "hook.completed",
  "memory.citation.referenced",
  "safety.review.started",
  "safety.review.completed",
  "terminal.input.sent",
  "wait.started",
  "wait.completed",
  "provider.notice.recorded",
  "session.starting",
  "session.started",
  "session.resuming",
  "session.resumed",
  "session.reconciled",
  "session.updated",
  "session.closed",
  "session.failed",
  "turn.submitted",
  "turn.accepted",
  "turn.started",
  "turn.completed",
  "turn.failed",
  "turn.interrupted",
  "turn.cancelled",
  "item.started",
  "item.delta",
  "item.completed",
  "item.failed",
  "usage.reported",
  "semantic_tool.input",
  "semantic_tool.result",
  "semantic_tool.reconciled",
  "mcp_app.discovered",
  "mcp_app.resource.resolved",
  "mcp_app.initializing",
  "mcp_app.ready",
  "mcp_app.tool_input",
  "mcp_app.tool_result",
  "mcp_app.action.requested",
  "mcp_app.action.resolved",
  "mcp_app.host_context.changed",
  "mcp_app.failed",
  "mcp_app.teardown",
  "runtime_request.created",
  "runtime_request.resolved",
  "runtime_request.expired",
  "runtime_request.cancelled",
  "interaction.request.proposed",
  "interaction.request.materialized",
  "interaction.request.rejected",
  "interaction.response.progressed",
  "interaction.response.resolved",
  "interaction.response.delivered",
  "run.attached",
  "run.detached",
  "run.result.proposed",
  "run.result.accepted",
  "run.result.rejected",
  "attention.request.proposed",
  "attention.request.routed",
  "attention.request.resolved",
  "attention.request.expired",
  "attention.request.superseded",
  "work.assessment.recorded",
  "issue.status.decision.recorded",
  "issue.status.decision.applied",
  "issue.status.decision.rejected",
  "issue.status.decision.superseded",
  "run.terminal",
]);
const NATIVE_RUN_SPAN_SCHEMA = "paperclip.run-performance-span.v1";
const NATIVE_RUN_SPAN_FIELDS = ["span", "parentSpan"] as const;
const NATIVE_RUN_SPAN_NAMES = new Set([
  "agent.turn",
  "environment.acquire",
  "environment.startup",
  "environment.workspace.realize",
  "native.coordinator.claim",
  "native.result.finalize",
  "native.session.execute",
  "provider.session.continuity_break",
  "provider.session.resume",
  "provider.time_to_first_agent_event",
  "provider.turn.queue",
  "runner.artifact.discover",
  "runner.artifact.prepare",
  "runner.prp.authenticate",
  "runner.prp.route.register",
  "runner.runtime.stage",
  "runner.session.bootstrap",
  "runner.session.resume",
  "runner.session.startup",
  "runner.transport.connect",
  "runner.transport.selected",
  "runner.turn.submit",
  "task.prepare",
  "task.run",
  "task.run.measured",
  "task.settle",
]);
const CLI_SECRET_FLAG_RE = new RegExp(
  String.raw`^-{1,2}${SECRET_FIELD_NAME_PATTERN}$`,
  "i",
);
const JSON_SECRET_FIELD_TEXT_RE = new RegExp(
  String.raw`((?:"|')?${SECRET_FIELD_NAME_PATTERN}(?:"|')?\s*:\s*(?:"|'))[^"'` +
    "`" +
    String.raw`\r\n]+((?:"|'))`,
  "gi",
);
const ESCAPED_JSON_SECRET_FIELD_TEXT_RE = new RegExp(
  String.raw`((?:\\")?${SECRET_FIELD_NAME_PATTERN}(?:\\")?\s*:\s*(?:\\"))[^\\\r\n]+((?:\\"))`,
  "gi",
);
const SECRET_TEXT_HINTS = [
  "api",
  "key",
  "token",
  "auth",
  "bearer",
  "secret",
  "pass",
  "credential",
  "jwt",
  "private",
  "cookie",
  "connectionstring",
  "sk-",
  "ghp_",
  "gho_",
  "ghu_",
  "ghs_",
  "ghr_",
] as const;
export const REDACTED_EVENT_VALUE = "***REDACTED***";

function maybeContainsSecretText(input: string) {
  const lower = input.toLowerCase();
  return (
    SECRET_TEXT_HINTS.some((hint) => lower.includes(hint)) ||
    input.includes(".")
  );
}

function inlineWhitespaceEnd(input: string, start: number): number {
  let index = start;
  while (
    index < input.length &&
    (input[index] === " " || input[index] === "\t")
  ) {
    index += 1;
  }
  return index;
}

function quotedValueBoundary(
  input: string,
  index: number,
): "hard" | "line" | "provisional" | "unsafe" {
  const boundary = input[index];
  if (boundary === undefined || /[,;&)}\]]/.test(boundary)) return "hard";
  if (boundary === "\r" || boundary === "\n") return "line";
  if (/\s/.test(boundary)) return "provisional";
  return "unsafe";
}

function isTrustedQuotedValueBoundary(input: string, index: number) {
  const boundary = quotedValueBoundary(input, index);
  return boundary === "hard" || boundary === "provisional";
}

function startsIndependentCredentialLine(input: string, index: number) {
  if (input[index] !== "\r" && input[index] !== "\n") return false;
  let lineStart = index + 1;
  if (input[index] === "\r" && input[lineStart] === "\n") lineStart += 1;
  const lineEndCandidates = [
    input.indexOf("\r", lineStart),
    input.indexOf("\n", lineStart),
  ].filter((candidate) => candidate >= 0);
  const lineEnd =
    lineEndCandidates.length > 0
      ? Math.min(...lineEndCandidates)
      : input.length;
  const words = input
    .slice(lineStart, lineEnd)
    .trimStart()
    .toLowerCase()
    .split(/[ \t]+/);
  return (
    (words[0] === "bearer" && words.length >= 2) ||
    (words[0] === "request" &&
      words[1] === "failed" &&
      words[2] === "with" &&
      words[3] === "bearer" &&
      words.length >= 5)
  );
}

function rawQuotedValueEnd(
  input: string,
  start: number,
  quote: '"' | "'",
): number {
  const end = input.length;
  let provisionalEnd: number | null = null;
  let unsafeAfterProvisional = false;
  for (let index = start + 1; index < end; index += 1) {
    if (input[index] === "\\") {
      index += 1;
      continue;
    }
    if (input[index] === quote) {
      const candidateEnd = index + 1;
      const boundary = quotedValueBoundary(input, candidateEnd);
      if (boundary === "hard") return candidateEnd;
      if (boundary === "provisional") {
        provisionalEnd = candidateEnd;
        unsafeAfterProvisional = false;
      } else if (
        boundary === "line" &&
        startsIndependentCredentialLine(input, candidateEnd)
      ) {
        return candidateEnd;
      } else {
        if (boundary === "line") provisionalEnd = null;
        unsafeAfterProvisional = true;
      }
    }
  }
  // Whitespace normally separates safe trailing context, so retain a final
  // provisional delimiter when no later quote contradicts it. Literal newlines
  // can occur inside provider-controlled credentials, so an unterminated
  // malformed value fails closed through the complete bounded diagnostic.
  return provisionalEnd !== null && !unsafeAfterProvisional
    ? provisionalEnd
    : end;
}

function escapedQuotedValueEnd(
  input: string,
  start: number,
  quote: '"' | "'",
): number {
  const end = input.length;
  let provisionalEnd: number | null = null;
  let unsafeAfterProvisional = false;
  for (let index = start + 2; index < end; index += 1) {
    if (input[index] !== "\\") continue;
    let afterSlashes = index + 1;
    while (afterSlashes < end && input[afterSlashes] === "\\") {
      afterSlashes += 1;
    }
    if (input[afterSlashes] !== quote) {
      index = afterSlashes - 1;
      continue;
    }
    // A serialized outer quote has one slash. Three or more slashes encode a
    // quote nested inside that value, so keep scanning for the outer delimiter.
    if (afterSlashes - index === 1) {
      const candidateEnd = afterSlashes + 1;
      const boundary = quotedValueBoundary(input, candidateEnd);
      if (boundary === "hard") return candidateEnd;
      if (boundary === "provisional") {
        provisionalEnd = candidateEnd;
        unsafeAfterProvisional = false;
      } else if (
        boundary === "line" &&
        startsIndependentCredentialLine(input, candidateEnd)
      ) {
        return candidateEnd;
      } else {
        if (boundary === "line") provisionalEnd = null;
        unsafeAfterProvisional = true;
      }
    }
    index = afterSlashes;
  }
  return provisionalEnd !== null && !unsafeAfterProvisional
    ? provisionalEnd
    : end;
}

function escapedQuoteAt(input: string, index: number): '"' | "'" | null {
  if (input[index] !== "\\") return null;
  const quote = input[index + 1];
  return quote === '"' || quote === "'" ? quote : null;
}

function credentialEndAfterQuotedDelimiter(input: string, quotedEnd: number) {
  if (isTrustedQuotedValueBoundary(input, quotedEnd)) return quotedEnd;
  if (startsIndependentCredentialLine(input, quotedEnd)) return quotedEnd;

  // A closing delimiter followed immediately by more token bytes is not a
  // trustworthy credential boundary (for example `"abc"defg`). Once a
  // provider diagnostic is malformed this way, whitespace is not a safe
  // boundary either (`"a"b c"`). Fail closed through the rest of the
  // diagnostic so no later credential fragment survives.
  return input.length;
}

interface AuthorizationCredentialRange {
  start: number;
  end: number;
  replacement: string;
}

function authorizationCredentialRange(
  input: string,
  wordEnd: number,
): AuthorizationCredentialRange | null {
  let valueStart = wordEnd;

  // JSON and serialized JSON close the quoted key before the colon. Treat a
  // quote as part of the key only when a colon follows it; otherwise it is the
  // opening delimiter of a header value such as Authorization "Bearer ...".
  const rawKeyQuote = input[valueStart];
  const escapedKeyQuote = escapedQuoteAt(input, valueStart);
  const keyQuoteWidth =
    rawKeyQuote === '"' || rawKeyQuote === "'" ? 1 : escapedKeyQuote ? 2 : 0;
  if (keyQuoteWidth > 0) {
    const possibleColon = inlineWhitespaceEnd(
      input,
      valueStart + keyQuoteWidth,
    );
    if (input[possibleColon] === ":") valueStart = possibleColon;
  }

  valueStart = inlineWhitespaceEnd(input, valueStart);
  if (input[valueStart] === ":" || input[valueStart] === "=") {
    valueStart = inlineWhitespaceEnd(input, valueStart + 1);
  }

  const rawValueQuote = input[valueStart];
  if (rawValueQuote === '"' || rawValueQuote === "'") {
    const quotedEnd = rawQuotedValueEnd(input, valueStart, rawValueQuote);
    const content = input.slice(valueStart + 1, quotedEnd - 1).trimStart();
    if (!/^(?:Bearer|Basic)\b/i.test(content)) return null;
    return {
      start: valueStart,
      end: credentialEndAfterQuotedDelimiter(input, quotedEnd),
      replacement: `${rawValueQuote}${REDACTED_EVENT_VALUE}${rawValueQuote}`,
    };
  }

  const escapedValueQuote = escapedQuoteAt(input, valueStart);
  if (escapedValueQuote) {
    const quotedEnd = escapedQuotedValueEnd(
      input,
      valueStart,
      escapedValueQuote,
    );
    const content = input.slice(valueStart + 2, quotedEnd - 2).trimStart();
    if (!/^(?:Bearer|Basic)\b/i.test(content)) return null;
    const delimiter = `\\${escapedValueQuote}`;
    return {
      start: valueStart,
      end: credentialEndAfterQuotedDelimiter(input, quotedEnd),
      replacement: `${delimiter}${REDACTED_EVENT_VALUE}${delimiter}`,
    };
  }

  const scheme = /^(?:Bearer|Basic)\b/i.exec(input.slice(valueStart));
  if (!scheme) return null;
  let credentialStart = inlineWhitespaceEnd(
    input,
    valueStart + scheme[0].length,
  );
  if (credentialStart === valueStart + scheme[0].length) return null;
  if (
    credentialStart >= input.length ||
    /[\r\n]/.test(input[credentialStart])
  ) {
    return null;
  }

  let end: number;
  const rawCredentialQuote = input[credentialStart];
  if (rawCredentialQuote === '"' || rawCredentialQuote === "'") {
    end = credentialEndAfterQuotedDelimiter(
      input,
      rawQuotedValueEnd(input, credentialStart, rawCredentialQuote),
    );
  } else {
    const escapedCredentialQuote = escapedQuoteAt(input, credentialStart);
    if (escapedCredentialQuote) {
      end = credentialEndAfterQuotedDelimiter(
        input,
        escapedQuotedValueEnd(input, credentialStart, escapedCredentialQuote),
      );
    } else {
      end = credentialStart;
      // Embedded quote/backtick bytes do not make an unquoted credential safe;
      // consume them through the next structural or whitespace boundary.
      while (end < input.length && !/[\s,;}\]]/.test(input[end])) end += 1;
    }
  }
  return { start: valueStart, end, replacement: REDACTED_EVENT_VALUE };
}

function redactAuthorizationCredentials(input: string): string {
  // Include compound diagnostic labels such as proxyAuthorization while the
  // value parser still requires a Basic/Bearer scheme before redacting.
  const authorizationWord = /\b[A-Za-z0-9_-]*Authorization[A-Za-z0-9_-]*\b/gi;
  const parts: string[] = [];
  let copiedThrough = 0;
  let match: RegExpExecArray | null;

  while ((match = authorizationWord.exec(input)) !== null) {
    const range = authorizationCredentialRange(
      input,
      match.index + match[0].length,
    );
    if (!range || range.start < copiedThrough) continue;
    parts.push(input.slice(copiedThrough, range.start), range.replacement);
    copiedThrough = range.end;
    authorizationWord.lastIndex = range.end;
  }

  if (copiedThrough === 0) return input;
  parts.push(input.slice(copiedThrough));
  return parts.join("");
}

function redactStandaloneBearerCredentials(input: string): string {
  const bearerWord = /\bBearer\b/gi;
  const parts: string[] = [];
  let copiedThrough = 0;
  let match: RegExpExecArray | null;

  while ((match = bearerWord.exec(input)) !== null) {
    const wordEnd = match.index + match[0].length;
    const credentialStart = inlineWhitespaceEnd(input, wordEnd);
    if (
      credentialStart === wordEnd ||
      credentialStart >= input.length ||
      /[\r\n]/.test(input[credentialStart])
    ) {
      continue;
    }

    let end: number;
    let replacement = REDACTED_EVENT_VALUE;
    const rawQuote = input[credentialStart];
    if (rawQuote === '"' || rawQuote === "'") {
      end = credentialEndAfterQuotedDelimiter(
        input,
        rawQuotedValueEnd(input, credentialStart, rawQuote),
      );
      replacement = `${rawQuote}${REDACTED_EVENT_VALUE}${rawQuote}`;
    } else {
      const escapedQuote = escapedQuoteAt(input, credentialStart);
      if (escapedQuote) {
        end = credentialEndAfterQuotedDelimiter(
          input,
          escapedQuotedValueEnd(input, credentialStart, escapedQuote),
        );
        const delimiter = `\\${escapedQuote}`;
        replacement = `${delimiter}${REDACTED_EVENT_VALUE}${delimiter}`;
      } else {
        end = credentialStart;
        while (end < input.length && !/[\s,;}\]]/.test(input[end])) end += 1;
      }
    }

    if (credentialStart < copiedThrough) continue;
    parts.push(input.slice(copiedThrough, credentialStart), replacement);
    copiedThrough = end;
    bearerWord.lastIndex = end;
  }

  if (copiedThrough === 0) return input;
  parts.push(input.slice(copiedThrough));
  return parts.join("");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sanitizeValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  // Adapter diagnostics are provider-controlled text. Secret-bearing header or
  // command fragments can appear under otherwise innocuous keys such as
  // `message`, `reason`, or inside arrays, so apply the text scanner at every
  // string leaf after validated protocol discriminators have had a chance to
  // opt in above in sanitizeRecord.
  if (typeof value === "string") {
    return JWT_VALUE_RE.test(value)
      ? REDACTED_EVENT_VALUE
      : redactSensitiveText(value);
  }
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (isSecretRefBinding(value)) {
    const version = safeSecretVersion(value.version);
    return {
      type: "secret_ref",
      secretId: value.secretId,
      ...(version === undefined ? {} : { version }),
      ...(value.projectionClass === "unclassified" ||
      value.projectionClass === "class_3_static_lease"
        ? { projectionClass: value.projectionClass }
        : {}),
      ...(value.projectionAllowlistKey === null
        ? { projectionAllowlistKey: null }
        : typeof value.projectionAllowlistKey === "string" &&
            PROJECTION_ALLOWLIST_KEY_RE.test(value.projectionAllowlistKey) &&
            redactSensitiveText(value.projectionAllowlistKey) ===
              value.projectionAllowlistKey
          ? { projectionAllowlistKey: value.projectionAllowlistKey }
          : {}),
    };
  }
  if (isUserSecretRefBinding(value)) {
    const version = safeSecretVersion(value.version);
    return {
      type: "user_secret_ref",
      key: value.key,
      ...(version === undefined ? {} : { version }),
      ...(typeof value.required === "boolean"
        ? { required: value.required }
        : {}),
      ...(typeof value.allowMissingOverride === "boolean"
        ? { allowMissingOverride: value.allowMissingOverride }
        : {}),
    };
  }
  if (isPlainBinding(value))
    return { type: "plain", value: sanitizeValue(value.value) };
  if (!isPlainObject(value)) return value;
  return sanitizeRecord(value);
}

const SECRET_REFERENCE_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USER_SECRET_KEY_RE = /^[A-Za-z0-9_.-]{1,120}$/;
const PROJECTION_ALLOWLIST_KEY_RE =
  /^[A-Za-z0-9_-]{1,80}\.[A-Za-z0-9_-]{1,80}$/;

function safeSecretVersion(value: unknown): number | "latest" | undefined {
  if (value === "latest") return value;
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function isSecretRefBinding(value: unknown): value is {
  type: "secret_ref";
  secretId: string;
  version?: unknown;
  projectionClass?: unknown;
  projectionAllowlistKey?: unknown;
} {
  if (!isPlainObject(value)) return false;
  return (
    value.type === "secret_ref" &&
    typeof value.secretId === "string" &&
    SECRET_REFERENCE_ID_RE.test(value.secretId)
  );
}

function isUserSecretRefBinding(value: unknown): value is {
  type: "user_secret_ref";
  key: string;
  version?: unknown;
  required?: unknown;
  allowMissingOverride?: unknown;
} {
  if (!isPlainObject(value)) return false;
  return (
    value.type === "user_secret_ref" &&
    typeof value.key === "string" &&
    USER_SECRET_KEY_RE.test(value.key) &&
    redactSensitiveText(value.key) === value.key
  );
}

function isPlainBinding(
  value: unknown,
): value is { type: "plain"; value: unknown } {
  if (!isPlainObject(value)) return false;
  return value.type === "plain" && "value" in value;
}

function sanitizeCommandArgs(args: unknown[]): unknown[] {
  let redactNext = false;
  return args.map((arg) => {
    if (redactNext) {
      redactNext = false;
      return REDACTED_EVENT_VALUE;
    }
    if (typeof arg !== "string") return sanitizeValue(arg);
    if (CLI_SECRET_FLAG_RE.test(arg.trim())) {
      redactNext = true;
      return arg;
    }
    return redactSensitiveText(arg);
  });
}

function isKnownPrpEventDiscriminator(
  container: Record<string, unknown>,
  key: string,
  value: unknown,
): value is string {
  return (
    key === "eventType" &&
    container.schema === "paperclip.prp.event.v1" &&
    container.schemaVersion === 1 &&
    typeof value === "string" &&
    PRP_V1_EVENT_TYPES.has(value)
  );
}

function isPaperclipSchemaDiscriminator(
  key: string,
  value: unknown,
): value is string {
  return (
    PAPERCLIP_SCHEMA_FIELDS.has(key) &&
    typeof value === "string" &&
    PAPERCLIP_PUBLIC_SCHEMA_IDS.has(value)
  );
}

export function sanitizeRecord(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (COMMAND_ARGS_PAYLOAD_KEY_RE.test(key) && Array.isArray(value)) {
      redacted[key] = sanitizeCommandArgs(value);
      continue;
    }
    if (COMMAND_PAYLOAD_KEY_RE.test(key) && typeof value === "string") {
      redacted[key] = redactSensitiveText(value);
      continue;
    }
    if (
      SECRET_PAYLOAD_KEY_RE.test(key) &&
      !AUDIT_REASON_PAYLOAD_KEY_RE.test(key) &&
      !isAuditCountField(key, value)
    ) {
      if (isSecretRefBinding(value)) {
        redacted[key] = sanitizeValue(value);
        continue;
      }
      if (isUserSecretRefBinding(value)) {
        redacted[key] = sanitizeValue(value);
        continue;
      }
      if (isPlainBinding(value)) {
        redacted[key] = { type: "plain", value: REDACTED_EVENT_VALUE };
        continue;
      }
      redacted[key] = REDACTED_EVENT_VALUE;
      continue;
    }
    // Interpret a validated schema field before applying generic value-shape
    // heuristics. The exemption is deliberately closed to this one PRP v1
    // discriminator; the same dotted string in any other field is redacted.
    if (isKnownPrpEventDiscriminator(record, key, value)) {
      redacted[key] = value;
      continue;
    }
    if (isPaperclipSchemaDiscriminator(key, value)) {
      redacted[key] = value;
      continue;
    }
    if (AUDIT_SURFACE_PAYLOAD_KEY_RE.test(key) && typeof value === "string") {
      redacted[key] = redactSensitiveText(value);
      continue;
    }
    if (
      typeof value === "string" &&
      JWT_VALUE_RE.test(value) &&
      !isPaperclipSchemaDiscriminator(key, value)
    ) {
      redacted[key] = REDACTED_EVENT_VALUE;
      continue;
    }
    redacted[key] = sanitizeValue(value);
  }
  return redacted;
}

export function redactEventPayload(
  payload: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!payload) return null;
  if (!isPlainObject(payload)) return payload;
  const sanitized = sanitizeRecord(payload);
  if (payload.schema !== NATIVE_RUN_SPAN_SCHEMA) return sanitized;

  // Native run span identities are controlled diagnostics emitted by
  // createNativeRunTrace, not provider data. Their dotted names overlap the
  // broad JWT-value heuristic, so restore only these two fields on the exact
  // run-performance schema. Hostnames and JWT-shaped values on every other
  // field and schema still fail closed through sanitizeRecord above.
  for (const field of NATIVE_RUN_SPAN_FIELDS) {
    const value = payload[field];
    if (typeof value === "string" && NATIVE_RUN_SPAN_NAMES.has(value)) {
      sanitized[field] = value;
    }
  }
  return sanitized;
}

function redactAgentEnvBinding(value: unknown): unknown {
  if (isSecretRefBinding(value) || isUserSecretRefBinding(value)) {
    return sanitizeValue(value);
  }
  if (typeof value === "string" || isPlainBinding(value)) {
    return { type: "plain", value: REDACTED_EVENT_VALUE };
  }
  if (value === null || value === undefined) return value;
  return REDACTED_EVENT_VALUE;
}

export function redactAgentAdapterConfig(
  adapterConfig: Record<string, unknown>,
): Record<string, unknown> {
  if (!isPlainObject(adapterConfig)) return adapterConfig;
  if (!isPlainObject(adapterConfig.env)) return redactEventPayload(adapterConfig) ?? {};

  // Redact `env` here and sanitize the remaining keys separately, so bindings
  // are never processed twice. `redactAgentEnvBinding` is authoritative for
  // `env`; keeping it out of `sanitizeRecord` means a future change there
  // cannot alter entries this function has already redacted.
  const { env, ...rest } = adapterConfig;
  const redactedEnv = Object.fromEntries(
    Object.entries(env).map(([key, value]) => [key, redactAgentEnvBinding(value)]),
  );

  return { ...(redactEventPayload(rest) ?? {}), env: redactedEnv };
}

export function redactSensitiveText(input: string): string {
  if (!maybeContainsSecretText(input)) return input;
  return redactCommandText(
    redactStandaloneBearerCredentials(redactAuthorizationCredentials(input))
      .replace(JSON_SECRET_FIELD_TEXT_RE, `$1${REDACTED_EVENT_VALUE}$2`)
      .replace(
        ESCAPED_JSON_SECRET_FIELD_TEXT_RE,
        `$1${REDACTED_EVENT_VALUE}$2`,
      ),
    REDACTED_EVENT_VALUE,
  );
}
