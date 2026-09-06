import { readFile, readdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { PUBLIC_CHAT_SCHEMA, SECRET_TEXT } from "./public-eval-chat.mjs";

export const PUBLIC_VIEWER_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'";
export const PUBLIC_VIEWER_DATA =
  /<script type="application\/json" id="paperclip-eval-report">([^<]*)<\/script>/u;
const ASSET = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:js|css|woff2)$/;

export function publicViewerShell(index, encodedPayload) {
  return index
    .replaceAll('"./assets/', '"../../viewer/assets/')
    .replace(
      "<head>",
      `<head>\n    <meta http-equiv="Content-Security-Policy" content="${PUBLIC_VIEWER_CSP}">`,
    )
    .replace(
      '<script type="module"',
      `<script type="application/json" id="paperclip-eval-report">${encodedPayload}</script>\n    <script type="module"`,
    );
}

export async function trustedViewerFiles(viewerRoot) {
  if (!viewerRoot || !(await lstat(viewerRoot)).isDirectory())
    throw new Error(
      "A trusted viewer build is required for public chat reports",
    );
  if (
    !(await lstat(join(viewerRoot, "index.html"))).isFile() ||
    !(await lstat(join(viewerRoot, "assets"))).isDirectory()
  )
    throw new Error("Trusted viewer must not use symlinks");
  const index = await readFile(join(viewerRoot, "index.html"), "utf8");
  const files = new Map();
  for (const entry of await readdir(join(viewerRoot, "assets"), {
    withFileTypes: true,
  })) {
    if (!entry.isFile() || entry.isSymbolicLink() || !ASSET.test(entry.name))
      throw new Error("Unexpected trusted viewer asset");
    files.set(
      `viewer/assets/${entry.name}`,
      await readFile(join(viewerRoot, "assets", entry.name)),
    );
  }
  if (
    ![...files.keys()].some((name) => name.endsWith(".js")) ||
    !index.includes('<script type="module"')
  )
    throw new Error("Incomplete trusted viewer build");
  return { index, files };
}

export function validatePublicChatPayload(payload) {
  if (
    payload?.publication?.schema !== PUBLIC_CHAT_SCHEMA ||
    payload.view?.sessionId !== "public-report" ||
    payload.view?.composer?.state !== "disabled" ||
    payload.view?.connection?.state !== "closed" ||
    payload.devtools !== null
  )
    throw new Error(
      "Public attempt must contain the read-only public chat projection",
    );
  const allowed = new Set([
    "attemptId",
    "caseId",
    "disposition",
    "passed",
    "checks",
    "view",
    "devtools",
    "navigation",
    "run",
    "publication",
  ]);
  if (Object.keys(payload).some((key) => !allowed.has(key)))
    throw new Error("Unknown public chat payload field");
  const fields = (value, names) => {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => !names.split(" ").includes(key))
    )
      throw new Error("Unknown public chat projection field");
  };
  fields(payload.publication, "schema notice");
  fields(payload.navigation, "suiteHref previous next");
  for (const link of [payload.navigation.previous, payload.navigation.next])
    if (link !== null) fields(link, "label href");
  fields(
    payload.run,
    "model provider driver providerVersion runnerProvider acpxAgent acpxProfile requestedModel effectiveModelHistory configuration sessionId providerSessionId agentVersion managedProfile retainedSession retainedSessionStatus fixtureDigest runnerPackageDigest runnerdDigest startedAt finishedAt durationMs runnerBuild initialRevision finalRevision usage",
  );
  if (
    payload.run.effectiveModelHistory?.length ||
    payload.run.managedProfile != null ||
    payload.run.acpxProfile != null
  )
    throw new Error("Public replay contains private provider metadata");
  if (payload.run.usage !== null)
    fields(
      payload.run.usage,
      "agentTurns providerRequests inputTokens outputTokens cachedInputTokens reasoningTokens providerReportedCostNanodollars estimatedCostNanodollars pricingVersion",
    );
  fields(
    payload.view,
    "schema sessionId mode identity issue turns composer evidence connection replay renderedAt",
  );
  fields(
    payload.view.identity,
    "agentLabel runnerLabel runnerAttached controlPlaneLabel controlPlaneTooltip replaySource",
  );
  fields(
    payload.view.issue,
    "identifier title status priority assignee runState scenarioId fixtureProfile",
  );
  fields(payload.view.composer, "state helper reason pendingInteractionId");
  fields(payload.view.connection, "state attempt");
  fields(
    payload.view.evidence,
    "tools calls authorization control_plane runner state traceability parity",
  );
  for (const check of payload.checks) {
    fields(
      check,
      "id kind passed detail evidenceRefs title description definition anchor",
    );
    fields(check.definition, "id kind");
    fields(check.anchor, "kind id");
    if (check.evidenceRefs.length)
      throw new Error("Public replay contains raw evidence references");
  }
  const visit = (value, key = "") => {
    if (typeof value === "string") {
      if (
        /(?:sessionId|providerSessionId)$/i.test(key) &&
        !["public-report", "unknown", "redacted"].includes(value)
      )
        throw new Error("Public replay contains a private session identity");
      for (const pattern of SECRET_TEXT) {
        pattern.lastIndex = 0;
        if (pattern.test(value))
          throw new Error(
            "Public replay contains credential or private reference material",
          );
      }
    } else if (value && typeof value === "object") {
      for (const [name, child] of Object.entries(value)) {
        if (
          /^(?:managedProfile|acpxProfile|providerTrace|mockState|stateHistory|trace|environment|env|apiKey|accessToken|password|secret)$/i.test(
            name,
          ) &&
          child != null
        )
          throw new Error("Public replay contains a private field");
        visit(child, name);
      }
    }
  };
  visit(payload);
  for (const section of [
    "tools",
    "authorization",
    "control_plane",
    "runner",
    "state",
    "traceability",
    "parity",
  ]) {
    if (
      !Array.isArray(payload.view.evidence?.[section]) ||
      payload.view.evidence[section].length
    )
      throw new Error("Public replay contains unprojected evidence");
  }
  for (const call of payload.view.evidence.calls) {
    fields(
      call,
      "id turnId operationId version providerRequest dispatchedCommand outcome result redactions threadAnchorId",
    );
    fields(call.result, "outcome detail");
    if (call.result.detail !== "Tool payload withheld from public replay.")
      throw new Error("Public replay contains raw call evidence");
  }
  for (const turn of payload.view.turns ?? []) {
    fields(turn, "id ordinal mode toolCallCount at stoppedByUser items");
    for (const item of turn.items ?? []) {
      if (
        ![
          "user_message",
          "agent_message",
          "tool_activity",
          "system_notice",
        ].includes(item.kind)
      )
        throw new Error("Public replay contains an unprojected item");
      const shapes = {
        user_message: "kind id at author body streaming",
        agent_message: "kind id at author body streaming",
        tool_activity:
          "kind id at operationId status summary input result evidenceRef",
        system_notice: "kind id at glyph text evidenceRef",
      };
      fields(item, shapes[item.kind]);
      if (item.evidenceRef) fields(item.evidenceRef, "section recordId");
      if (
        item.kind === "tool_activity" &&
        (JSON.stringify(item.input) !==
          JSON.stringify({
            detail: "Arguments withheld from public replay.",
          }) ||
          Object.keys(item.result).sort().join(",") !== "detail,outcome" ||
          item.result.detail !== "Tool payload withheld from public replay.")
      )
        throw new Error("Public replay contains a raw tool payload");
    }
  }
}

export function validatePublicViewerPage(content, trustedIndex) {
  const match = content.match(PUBLIC_VIEWER_DATA);
  if (!match || publicViewerShell(trustedIndex, match[1]) !== content)
    throw new Error("Public viewer page differs from the trusted shell");
  const payload = JSON.parse(match[1]);
  validatePublicChatPayload(payload);
  return payload;
}
