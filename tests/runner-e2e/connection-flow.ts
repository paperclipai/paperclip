import { createHash } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { aiRoutingModel } from "../../packages/shared/src/ai-provider-routing.js";
import { getConnectableAppDefinition } from "../../packages/shared/src/app-definitions.js";
import { connectionCell, type ConnectionHarness, type ConnectionMode } from "./connection-cases.js";
import { ConnectionBlock, ConnectionFailure, type ConnectionConfig, type resolveConnectionSettings } from "./connection-config.js";
import { ConnectionApi, connectionDelay } from "./connection-target.js";
import { createConnectionProof, verifyConnectionArtifact, verifyConnectionRun, completedConnectionArtifactRun, connectionProbeChecks, type ConnectionEvidence } from "./connection-evidence.js";
import { createTaskThroughUi, submitTaskReply } from "./user-actions.js";
import { collectRunEvents } from "./run-observations.js";
import type { MatrixExecution } from "./types.js";

type Row = Record<string, any>;
type Settings = ReturnType<typeof resolveConnectionSettings>;
export interface ConnectionFlowInput {
  page: Page; api: ConnectionApi; execution: MatrixExecution; config: ConnectionConfig; settings: Settings;
  company: Row; environment: Row; secret?: string; nonce: string; privateDir: string;
  evidence: ConnectionEvidence;
  checkpoint(phase: string): Promise<void>;
  observeRun(run: Row): void;
  createdConnectionIds: ReadonlySet<string>;
  refreshOwnedConnections(): Promise<void>;
  assertActive(): void;
}

async function choose(page: Page, label: string, name: string) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name, exact: true }).click();
}

async function openAdvanced(page: Page, mode: ConnectionMode) {
  const names: Record<string, string> = { openrouter: "OpenRouter", bedrock: "Amazon Bedrock", responses: "Custom gateway", messages: "Custom gateway", chat: "Custom gateway" };
  await page.getByRole("button", { name: new RegExp(`^${names[mode]}`) }).click();
}

async function fillGateway(input: ConnectionFlowInput) {
  const { page, settings, secret } = input;
  const { mode } = connectionCell(input.execution);
  if (settings.route?.baseURL) {
    await page.getByLabel("Provider URL", { exact: true }).fill(settings.route.baseURL);
    const format = page.getByRole("combobox", { name: "API format", exact: true });
    if (await format.isEnabled()) await choose(page, "API format", ({ responses: "OpenAI Responses · Codex", messages: "Anthropic Messages · Claude", chat: "Chat Completions · OpenCode, Hermes" } as Record<string, string>)[mode]!);
  }
  if (mode === "bedrock") await page.getByLabel("AWS region", { exact: true }).fill(settings.route!.region!);
  if (settings.route?.auth !== "bearer") await choose(page, "Authentication", settings.route?.auth === "none" ? "No authentication" : "API key · x-api-key");
  if (secret) await page.getByLabel("API key", { exact: true }).fill(secret);
  // Normal defaults stay collapsed. Model alias is selected in Configure.
  await page.getByRole("button", { name: "Connect", exact: true }).last().click();
}

async function submitConnection(input: ConnectionFlowInput, submit: () => Promise<void>) {
  const route = `${input.api.origin}/api/companies/${input.company.id}/ai-connections`;
  const response = input.page.waitForResponse(response => response.url() === route && response.request().method() === "POST", { timeout: 60_000 }).catch(() => null);
  await submit();
  const created = await response;
  if (!created) throw new ConnectionFailure("connection_request_timeout");
  if (created.ok()) return;
  const payload = await created.json().catch(() => ({}));
  const allowed = ["ai_connection_api_key_rejected", "ai_connection_verification_failed"];
  const code = allowed.includes(payload?.details?.code) ? payload.details.code : "connection_request_rejected";
  input.evidence.creationFailure = { status: created.status(), code };
  if (code === "ai_connection_api_key_rejected") throw new ConnectionBlock("missing_credential", code);
  throw new ConnectionFailure(code);
}

async function waitForFreshConnection(input: ConnectionFlowInput, before: Set<string>) {
  const { page, api, config, evidence, company } = input;
  const { harness, mode } = connectionCell(input.execution);
  const deadline = Date.now() + (mode === "subscription" ? config.browser.loginTimeoutMs : 90_000);
  let loginOpened = false;
  let connected = false;
  while (Date.now() < deadline) {
    input.assertActive();
    await input.refreshOwnedConnections();
    const list = await api.get(`/api/companies/${company.id}/ai-connections`);
    const fresh = list.connections.filter((c: Row) => !before.has(c.id) && input.createdConnectionIds.has(c.id));
    if (fresh.length > 1) throw new ConnectionFailure("unexpected_multiple_connections");
    if (fresh.length === 1) {
      const connection = fresh[0];
      if (connection.status !== "connected" || connection.method !== (mode === "subscription" ? "subscription" : "api_key")) throw new ConnectionFailure("saved_connection_method_or_status_mismatch");
      return connection;
    }
    if (mode === "subscription") {
      const signIn = page.getByRole("link", { name: /^Sign in to / }).first();
      const cloudSignIn = page.getByRole("button", { name: /^Sign in to / }).first();
      if (!loginOpened && (await signIn.isVisible() || await cloudSignIn.isVisible())) {
        // Observe before clicking. No token, code, URL, or popup content is recorded.
        const popup = page.context().waitForEvent("page", { timeout: 10_000 }).catch(() => undefined);
        if (await signIn.isVisible()) await signIn.click(); else if (await cloudSignIn.isEnabled()) await cloudSignIn.click();
        await popup;
        loginOpened = true;
        evidence.assisted = true;
        evidence.waits.push({ kind: "provider_login", startedAt: new Date().toISOString() });
        await input.checkpoint("awaiting_provider_login");
        console.log(`[provider-connections] Sign in to ${harness.label} in the opened browser (${config.browser.accountAlias}); complete the code/consent step in Paperclip. This test resumes automatically.`);
      }
      // Grok currently exposes a terminal handoff; do not pretend it has the same browser flow.
      if (!loginOpened && harness.id === "grok" && await page.getByRole("button", { name: "Copy sign-in command" }).isVisible()) {
        loginOpened = true;
        evidence.assisted = true;
        evidence.waits.push({ kind: "provider_login", startedAt: new Date().toISOString() });
        await input.checkpoint("awaiting_provider_login");
        console.log("[provider-connections] Grok requires the sign-in command shown in Paperclip. Complete that production handoff; the test will resume automatically.");
      }
      const connect = page.getByRole("button", { name: "Connect", exact: true }).last();
      if (!connected && await connect.isVisible() && await connect.isEnabled()) { await connect.click(); connected = true; }
      if (await page.getByRole("alert").filter({ hasText: /expired|could not|failed|invalid/i }).count()) throw new ConnectionFailure("provider_login_reported_error");
    }
    await connectionDelay(1_000);
  }
  if (mode === "subscription" && loginOpened) throw new ConnectionBlock("awaiting_user", "provider_login_deadline_reached");
  throw new ConnectionFailure("connection_creation_timeout");
}

async function selectSavedConnection(page: Page, connection: Row, harness: ConnectionHarness, mode: ConnectionMode) {
  await page.getByRole("heading", { name: /^(Connect a model|Configure your agent)$/ }).waitFor();
  const advanced = !["subscription", "api-key"].includes(mode);
  const connectionType = page.getByRole("radiogroup", { name: "Connection type", exact: true });
  if (["claude", "codex", "grok"].includes(harness.id)) {
    await connectionType.waitFor({ state: "visible" });
    if (advanced) {
      await connectionType.getByRole("radio", { name: /Advanced/ }).click();
      await choose(page, "Connection", connection.name);
      await page.getByRole("button", { name: "Use connection", exact: true }).click();
    } else {
      await connectionType.getByRole("radio", { name: mode === "subscription" ? /Subscription/ : /API key/ }).click();
      const saved = page.getByRole("combobox", { name: mode === "subscription" ? "Saved subscription" : "Saved API key", exact: true });
      await saved.waitFor({ state: "visible" });
      const option = await saved.locator("option").filter({ hasText: connection.name }).first().getAttribute("value");
      if (!option) throw new ConnectionFailure("saved_connection_option_missing");
      await saved.selectOption(option);
      await page.getByRole("button", { name: mode === "subscription" ? "Use saved subscription" : "Use saved API key", exact: true }).click();
    }
  } else {
    await choose(page, "Connection", connection.name);
  }
}

async function createConnectionThroughUi(input: ConnectionFlowInput, agentURL: string) {
  const { page, api, company, evidence } = input;
  const { harness, mode, entry } = connectionCell(input.execution);
  const priorConnections = (await api.get(`/api/companies/${company.id}/ai-connections`)).connections as Row[];
  const before = new Set<string>(priorConnections.map(c => c.id));
  // Fresh-creation proof cannot be satisfied by an existing personal default.
  if (priorConnections.some(connection => connection.status !== "revoked")) throw new ConnectionBlock("blocked_target", "fresh_connection_requires_empty_qa_company");
  const advanced = !["subscription", "api-key"].includes(mode);
  await input.checkpoint("connection_navigation");
  if (entry === "apps") {
    await page.goto(`${api.origin}/${company.issuePrefix}/apps`, { waitUntil: "domcontentloaded" });
    const catalogSlug = advanced ? ({ openrouter: "openrouter", bedrock: "bedrock", responses: "responses-api", messages: "messages-api", chat: "chat-completions-api" } as Record<string, string>)[mode]! : harness.provider;
    const definition = getConnectableAppDefinition(catalogSlug);
    if (!definition) throw new ConnectionFailure("connection_catalog_entry_missing");
    await page.getByRole("button", { name: `Connect ${definition.name}`, exact: true }).click();
    const next = page.getByRole("button", { name: /^(Save and continue|Continue)$/ }).last();
    if (!advanced && await next.isVisible()) await next.click();
    if (!advanced && harness.provider !== "google") {
      // The credential step loads asynchronously. Wait for its provider tile
      // before inspecting the mode switch, otherwise a still-loading page can
      // skip the API-key switch and leave the subscription form selected.
      await page.getByRole("radio", { name: new RegExp(harness.id === "grok" ? "Grok" : harness.label) }).click();
      const switcher = page.getByRole("button", { name: mode === "subscription" ? "Use subscription instead" : "Use API key instead", exact: true });
      if (await switcher.isVisible()) await switcher.click();
    }
  } else {
    await page.goto(agentURL, { waitUntil: "domcontentloaded" });
    const tiles = page.getByRole("radiogroup", { name: "Connection type", exact: true });
    if (["claude", "codex", "grok"].includes(harness.id)) {
      const choice = tiles.getByRole("radio", { name: advanced ? /Advanced/ : mode === "subscription" ? /Subscription/ : /API key/ });
      await choice.click();
      await expect(choice).toHaveAttribute("aria-checked", "true");
    }
    if (advanced || !["claude", "codex", "grok"].includes(harness.id)) {
      await choose(page, "Connection", "Connect an account…");
      if (advanced) {
        const advancedProviders = page.locator("summary").filter({ hasText: "Advanced providers" });
        if (await advancedProviders.isVisible()) {
          await advancedProviders.click();
          // The account dialog's disclosure leads to the provider chooser;
          // the chooser's own disclosure already contains provider buttons.
          const chooseProvider = page.getByRole("button", { name: "Choose another provider or gateway", exact: true });
          if (await chooseProvider.isVisible()) await chooseProvider.click();
        }
        await openAdvanced(page, mode);
      }
    }
  }
  await input.checkpoint("connection_creation");
  if (advanced) await submitConnection(input, () => fillGateway(input));
  else if (mode === "api-key") {
    const savedKey = page.getByRole("combobox", { name: "Saved API key", exact: true });
    if (await savedKey.isVisible()) await savedKey.selectOption("");
    await page.getByLabel("API key", { exact: true }).fill(input.secret!);
    await submitConnection(input, () => page.getByRole("button", { name: "Connect", exact: true }).last().click());
  }
  const connection = await waitForFreshConnection(input, before);
  evidence.connectionId = connection.id;
  evidence.checkpoints.connection_created = true;
  evidence.waits.forEach(wait => { wait.finishedAt ??= new Date().toISOString(); });
  if (advanced) {
    const expectedKind = ["bedrock", "openrouter"].includes(mode) ? mode : "gateway";
    if (connection.routing?.kind !== expectedKind || (mode !== "openrouter" && connection.routing?.protocol !== mode) ||
      (input.settings.route?.baseURL && connection.routing?.baseUrl !== input.settings.route.baseURL) ||
      (mode === "bedrock" && connection.routing?.region !== input.settings.route?.region)) throw new ConnectionFailure("saved_routing_mismatch");
  } else if (connection.provider !== harness.provider) throw new ConnectionFailure("saved_provider_mismatch");
  // Navigate away and return through the normal list: proof includes durable UI state.
  await page.goto(`${api.origin}/${company.issuePrefix}/apps`, { waitUntil: "domcontentloaded" });
  await expect(page.getByText(connection.name, { exact: true }).first()).toBeVisible();
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByText(connection.name, { exact: true }).first()).toBeVisible();
  evidence.checkpoints.connection_reloaded = true;
  await input.checkpoint("connection_reloaded");
  await page.goto(agentURL, { waitUntil: "domcontentloaded" });
  await input.checkpoint("select_saved_connection");
  await selectSavedConnection(page, connection, harness, mode);
  await input.checkpoint("configure_agent");
  return connection;
}

async function selectModel(page: Page, model: string) {
  const select = page.getByRole("combobox", { name: "Model", exact: true });
  await select.waitFor({ state: "visible" });
  await expect(select).not.toHaveAttribute("aria-busy", "true", { timeout: 60_000 });
  const values = await select.locator("option").evaluateAll(options => options.map(option => (option as HTMLOptionElement).value));
  const matched = values.find(value => value === model || value === `openrouter/${model}`);
  if (matched) await select.selectOption(matched);
  else {
    await select.selectOption({ label: "Enter custom model…" });
    await page.getByLabel("Model ID", { exact: true }).fill(model);
  }
}

export async function runConnectionFlow(input: ConnectionFlowInput) {
  const { page, api, execution, evidence, settings, company, environment, config } = input;
  const { harness, mode } = connectionCell(execution);
  const agentName = `Connection QA ${input.nonce}`;
  const agentURL = `${api.origin}/${company.issuePrefix}/agents/new?${new URLSearchParams({ name: agentName, adapterType: execution.profile.adapterType, runnerProvider: harness.id })}`;
  const connection = await createConnectionThroughUi(input, agentURL);
  await expect(page.getByRole("heading", { name: "Configure your agent", exact: true })).toBeVisible({ timeout: 120_000 });
  const environmentSelect = page.getByRole("combobox", { name: "Environment", exact: true });
  const selectedEnv = await environmentSelect.inputValue();
  if (selectedEnv !== environment.id) {
    if (!(await environmentSelect.isEnabled())) throw new ConnectionBlock("blocked_target", "requested_execution_environment_unavailable");
    await environmentSelect.selectOption(environment.id);
    if (["claude", "codex", "grok"].includes(harness.id)) await selectSavedConnection(page, connection, harness, mode);
  }
  if (await environmentSelect.inputValue() !== environment.id) throw new ConnectionBlock("blocked_target", "requested_execution_environment_unavailable");
  await input.checkpoint("select_model");
  await selectModel(page, settings.model);
  await input.checkpoint("setup_probe");
  const response = page.waitForResponse(response => response.url().startsWith(`${api.origin}/api/companies/${company.id}/adapters/`) && response.url().endsWith("/test-environment"), { timeout: 120_000 });
  await page.getByRole("button", { name: /^(Run test|Test again)$/ }).click();
  const probe = await response;
  const result = await probe.json();
  evidence.setupChecks = connectionProbeChecks(result);
  if (evidence.setupChecks.some(check => check.level === "error" && (check.code === "hermes_cli_not_found" || /^(claude|codex|grok|opencode|gemini)_command_unresolvable$/.test(check.code))))
    throw new ConnectionBlock("blocked_target", "runtime_cli_required");
  if (!probe.ok() || result.status !== "pass") throw new ConnectionFailure("setup_probe_failed");
  evidence.checkpoints.setup_probe = true;
  await page.getByRole("button", { name: "Finish setup", exact: true }).click();
  let agent: Row | undefined;
  const deadline = Date.now() + 60_000;
  while (!agent && Date.now() < deadline) {
    agent = (await api.get<Row[]>(`/api/companies/${company.id}/agents`)).find(row => row.name === agentName);
    if (!agent) await connectionDelay(500);
  }
  if (!agent) throw new ConnectionFailure("agent_creation_failed");
  if (agent.defaultEnvironmentId !== environment.id) {
    // A null override is valid only when the instance default is this exact environment.
    const instance = await api.get<Row>("/api/instance/settings");
    const effective = agent.defaultEnvironmentId ?? instance.defaultEnvironmentId
      ?? (environment.driver === "local" ? environment.id : null);
    if (effective !== environment.id) throw new ConnectionFailure("saved_agent_environment_mismatch");
  }
  evidence.agentId = agent.id;
  evidence.checkpoints.agent_created = true;
  const expectedModel = connection.routing
    ? aiRoutingModel(connection.routing, harness.adapter, settings.model)
    : settings.model;
  if (agent.adapterType !== execution.profile.adapterType || agent.adapterConfig?.model !== expectedModel) throw new ConnectionFailure("agent_harness_or_model_mismatch");
  const binding = agent.runtimeConfig?.aiConnection;
  if (!binding || binding.method !== connection.method || (binding.mode !== "responsible_user" && binding.connectionId !== connection.id)) throw new ConnectionFailure("agent_binding_mismatch");
  // Fixtures may constrain cost/scheduling, but cannot repair or replace the tested credentials/config.
  await api.patch(`/api/agents/${agent.id}`, { budgetMonthlyCents: config.budgetCents });
  evidence.checkpoints.binding = true;
  await input.checkpoint("first_task");
  const proof = createConnectionProof();
  // Provider qualification must not depend on task-level attachment ingestion.
  // Native runners admit chat attachments, while the new-task dialog uploads
  // its files after scheduling. Supply identical oracle bytes in the task so
  // every harness can decode them with its actual tools.
  evidence.inputTransport = "prompt_base64";
  const title = `Connection artifact ${input.nonce}`;
  const createdTask = await createTaskThroughUi({ page, issuePrefix: company.issuePrefix, agentName, title, workMode: "standard", prompt: [
    "Complete this bounded connection acceptance task. Using your actual tools, decode the following base64 into connection-input.json and read the file. Preserve the exact decoded bytes, including the final newline.",
    `Input bytes (base64): ${Buffer.from(proof.input, "utf8").toString("base64")}`,
    "Create the input and output files inside your current workspace using relative filenames. Do not put them in /tmp or another directory outside the workspace.",
    'Write connection-proof.json with exactly this schema: {"nonce": string, "count": number, "total": number, "sha256": string}. Set nonce from the input, count to the number of values, total to their sum, and sha256 to the hash of the exact input file bytes. All four fields are required; use the literal field name "total", not "sum". Compute and validate with a tool; do not guess or paraphrase the data.',
    "Deliver connection-proof.json as a downloadable attachment on this task. Use the normal Paperclip artifact/attachment workflow and include its download link in your final response. Then mark this task done. Do not create other tasks, read credentials, or inspect unrelated files.",
    execution.profile.generation === "native" ? "Use your native register_deliverable tool with workspace-relative contentRef connection-proof.json and the exact byteSize and SHA-256 of that output file. Never submit an absolute contentRef." : "",
  ].join("\n") });
  const issue = await api.get<Row>(`/api/issues/${createdTask.issueId}`);
  if (issue.companyId !== company.id) throw new ConnectionFailure("task_creation_failed");
  const runs = new Map<string, Row>();
  async function completedRun(after: Set<string>, filename: string) {
    const deadline = Date.now() + config.turnTimeoutMs;
    while (Date.now() < deadline) {
    input.assertActive();
      const summaries = await api.get<Row[]>(`/api/issues/${issue!.id}/runs`);
      for (const row of summaries) {
        const id = row.runId ?? row.id;
        if (id && !runs.has(id)) runs.set(id, await api.get(`/api/heartbeat-runs/${id}`));
        else if (id && !["succeeded", "failed", "cancelled", "interrupted", "timed_out"].includes(runs.get(id)!.status)) runs.set(id, await api.get(`/api/heartbeat-runs/${id}`));
        if (id) input.observeRun(runs.get(id)!);
      }
      if (runs.size > config.maxRuns) throw new ConnectionFailure("provider_run_limit_exceeded");
      const next = [...runs.values()].filter(run => !after.has(run.id));
      if (next.some(run => ["failed", "cancelled", "interrupted", "timed_out"].includes(run.status))) throw new ConnectionFailure("agent_run_failed");
      const complete = next.find(run => verifyConnectionRun(run, { agentId: agent!.id, connectionId: connection.id, method: connection.method, runtimeMode: execution.profile.generation, environmentId: environment.id }));
      if (complete) {
        const status = (await api.get(`/api/issues/${issue!.id}`)).status;
        if (status === "done") {
          // A disposition repair may still be running after an earlier turn
          // succeeded. Qualify the settled successful run that uploaded this
          // artifact, preserving the configured run and time limits.
          const attachments = await api.get<Row[]>(`/api/issues/${issue!.id}/attachments`);
          const delivered = completedConnectionArtifactRun(next, attachments, filename,
            { agentId: agent!.id, connectionId: connection.id, method: connection.method, runtimeMode: execution.profile.generation, environmentId: environment.id });
          if (delivered) return delivered;
          if (next.every(run => ["succeeded", "failed", "cancelled", "interrupted", "timed_out"].includes(run.status))) throw new ConnectionFailure("run_attributed_artifact_missing");
        }
        if (status === "blocked") throw new ConnectionFailure("task_blocked_after_provider_run");
      }
      if (next.some(run => run.status === "succeeded" && !verifyConnectionRun(run, { agentId: agent!.id, connectionId: connection.id, method: connection.method, runtimeMode: execution.profile.generation, environmentId: environment.id }))) throw new ConnectionFailure("run_attribution_mismatch");
      await connectionDelay(1500);
    }
    throw new ConnectionFailure("agent_run_or_attribution_timeout");
  }
  async function artifact(filename: string, expected: Record<string, unknown>, run: Row) {
    const attachments = await api.get<Row[]>(`/api/issues/${issue!.id}/attachments`);
    const attachment = attachments.find(row => row.originalFilename === filename && row.createdByAgentId === agent!.id && row.originatingRunId === run.id);
    if (!attachment) throw new ConnectionFailure("run_attributed_artifact_missing");
    const bytes = await api.bytes(`/api/attachments/${attachment.id}/content`);
    let actual: Record<string, unknown> = {};
    try { actual = JSON.parse(bytes.toString("utf8")); } catch { /* The independent verifier fails below. */ }
    evidence.artifactChecks ??= [];
    evidence.artifactChecks.push({ filename, runId: run.id, sha256: createHash("sha256").update(bytes).digest("hex"),
      fields: Object.fromEntries(Object.entries(expected).map(([key, value]) => [key, actual?.[key] === value])), exactFields: Boolean(actual && Object.keys(actual).length === Object.keys(expected).length) });
    if (!verifyConnectionArtifact(bytes, expected)) throw new ConnectionFailure("independent_artifact_verification_failed");
    await page.goto(`${api.origin}/${company.issuePrefix}/issues/${issue!.identifier}`, { waitUntil: "domcontentloaded" });
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator(`a[href*="/api/attachments/${attachment.id}/content"]`).first()).toBeVisible({ timeout: 30_000 });
    evidence.artifactSha256 = createHash("sha256").update(bytes).digest("hex");
  }
  const first = await completedRun(new Set(), "connection-proof.json");
  evidence.checkpoints.first_run = true;
  await artifact("connection-proof.json", proof.expected, first);
  evidence.checkpoints.artifact = true;
  // Artifact upload provenance is a server-owned tool-side effect in both runner generations.
  const events = await collectRunEvents<Row>((afterSeq, limit) => api.get(`/api/heartbeat-runs/${first.id}/events?afterSeq=${afterSeq}&limit=${limit}`));
  const toolReceipt = events.some(event => event.eventType === "tool.execution.completed" || (event.eventType === "item.completed" && ["tool_result", "command_execution"].includes(event.payload?.prpEvent?.payload?.item?.type)));
  // Legacy adapters may expose their tool transcript only in the run log; upload attribution is still a durable successful tool effect.
  evidence.checkpoints.tool_receipt = execution.profile.generation === "legacy" || toolReceipt;
  if (!evidence.checkpoints.tool_receipt) throw new ConnectionFailure("native_tool_receipt_missing");
  await input.checkpoint("followup");
  const previousRuns = new Set(runs.keys());
  await submitTaskReply(page, "Using the original connection-input.json decoded from this task, deliver connection-followup.json with exactly nonce, minimum, maximum, and total of the original values. Use exactly this JSON schema: {\"nonce\": string, \"minimum\": number, \"maximum\": number, \"total\": number}. All four fields are required. Compute with a tool and validate the file against all four fields before attaching it and its download link. Then mark this task done. Do not create other tasks or read credentials.");
  const second = await completedRun(previousRuns, "connection-followup.json");
  await artifact("connection-followup.json", proof.followup, second);
  evidence.checkpoints.followup = true;
  evidence.checkpoints.visible_result = true;
  return { issueId: issue.id as string, issueIdentifier: issue.identifier as string };
}
