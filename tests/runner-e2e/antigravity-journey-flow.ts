import { randomUUID } from "node:crypto";
import { expect, type Page, type Request, type Route } from "@playwright/test";
import { ConnectionFailure } from "./connection-config.js";
import { ConnectionApi } from "./connection-target.js";
import { ANTIGRAVITY_JOURNEY_MODEL, type AntigravityJourneyConfig } from "./antigravity-journey-config.js";
import { verifyAntigravityJourneyTurn, type AntigravityJourneyEvidence } from "./antigravity-journey-evidence.js";
import type { AntigravityJourneyResources, prepareAntigravityJourney } from "./antigravity-journey-fixtures.js";
import { openAntigravityCreatedTask, assertAntigravityCleanComposer, assertAntigravityFileActivity, assertAntigravityReady, assertAntigravityTaskDone, inspectAntigravityArtifact, openAntigravityAgentFromRoster, selectAntigravityFromOrdinaryPicker } from "./antigravity-journey-ui.js";
import { submitTaskReply } from "./user-actions.js";

type Row = Record<string, any>;
export interface AntigravityJourneyFlowInput {
  page: Page; api: ConnectionApi; config: AntigravityJourneyConfig; prepared: Awaited<ReturnType<typeof prepareAntigravityJourney>>;
  resources: AntigravityJourneyResources; evidence: AntigravityJourneyEvidence;
  checkpoint(id: keyof AntigravityJourneyEvidence["checkpoints"], page: Page): Promise<void>;
  phase(id: string): Promise<void>;
  persistResources(): Promise<void>;
  observeRun(run: Row): Promise<void>;
  beforeAdmission(): Promise<void>;
  assertActive(): void;
}

export async function captureAntigravityAgentDraft(page: Page, resources: AntigravityJourneyResources,
  persistResources: () => Promise<void>, submit: () => Promise<void>, expectedCreatorUserId: string): Promise<Row> {
  const matches = (url: URL) => /^\/api\/companies\/[^/]+\/agents$/u.test(url.pathname);
  let captured: Request | undefined;
  let rejectRoute!: (error: unknown) => void;
  const routeFailure = new Promise<never>((_resolve, reject) => { rejectRoute = reject; });
  const handler = async (route: Route) => {
    const request = route.request();
    try {
      if (request.method() !== "POST") { await route.continue(); return; }
      const url = new URL(request.url());
      let body: Row;
      try { body = request.postDataJSON(); } catch { throw new ConnectionFailure("agent_creation_request_mismatch"); }
      if (captured || url.origin !== resources.origin || url.pathname !== `/api/companies/${resources.companyId}/agents`
        || !body || typeof body !== "object" || Array.isArray(body) || body.name !== resources.agentName
        || typeof body.setupId !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(body.setupId)
        || typeof expectedCreatorUserId !== "string" || !expectedCreatorUserId)
        throw new ConnectionFailure("agent_creation_request_mismatch");
      const witness = { setupId: body.setupId, companyId: resources.companyId, agentName: resources.agentName,
        provider: "antigravity" as const, creatorUserId: expectedCreatorUserId, origin: resources.origin };
      if ((resources.agentId && resources.agentId !== witness.setupId) || (resources.agentCreationRequest
        && Object.entries(witness).some(([key, value]) => resources.agentCreationRequest![key as keyof typeof witness] !== value)))
        throw new ConnectionFailure("agent_creation_request_mismatch");
      captured = request;
      resources.agentCreationRequest = witness;
      resources.retained = true;
      await persistResources();
      // Continue the ordinary UI request unchanged only after its recovery identity is durable.
      await route.continue();
    } catch (error) {
      await route.abort("failed").catch(() => {});
      rejectRoute(error);
    }
  };
  let primary: unknown;
  await page.route(matches, handler);
  try {
    const creation = page.waitForResponse(response => response.request() === captured);
    const receipt = Promise.race([creation, routeFailure]);
    // A submit failure must not leave a later response timeout unhandled.
    void receipt.catch(() => {});
    await Promise.race([submit(), routeFailure]);
    const created = await receipt;
    if (!created.ok()) throw new ConnectionFailure("agent_draft_creation_failed");
    const draft = await created.json();
    if (!draft || typeof draft !== "object" || Array.isArray(draft) || !resources.agentCreationRequest || draft.id !== resources.agentCreationRequest.setupId
      || draft.companyId !== resources.companyId || draft.name !== resources.agentName || draft.createdByUserId !== expectedCreatorUserId)
      throw new ConnectionFailure("agent_creation_receipt_mismatch");
    return draft;
  } catch (error) { primary = error; throw error; }
  finally {
    try { await page.unroute(matches, handler); }
    catch (error) {
      if (!primary && !page.isClosed()) throw error;
      if (primary instanceof Error) Object.assign(primary, { agentCreationRouteCleanupFailed: true });
    }
  }
}

export async function runAntigravityJourneyFlow(input: AntigravityJourneyFlowInput) {
  const { page, api, config, prepared, resources, evidence } = input;
  const { company, connection, environment } = prepared;
  const marker = `ANTIGRAVITY-INSTRUCTION-${randomUUID()}`;
  const followupMarker = `ANTIGRAVITY-FOLLOWUP-${randomUUID()}`;
  const firstBytes = Buffer.from(`${marker}\n`), followupBytes = Buffer.from(`${marker}\n${followupMarker}\n`);
  const checkpoint = async (id: keyof AntigravityJourneyEvidence["checkpoints"]) => { input.assertActive(); await input.checkpoint(id, page); };
  if (!/^[A-Za-z0-9]+$/.test(company.issuePrefix)) throw new ConnectionFailure("invalid_journey_company_prefix");
  const dashboard = `/${company.issuePrefix}/dashboard`;
  await input.phase("agent_navigation");
  await page.goto(`${api.origin}${dashboard}`);
  await page.waitForURL(url => url.origin === api.origin && url.pathname === dashboard);
  await page.getByRole("link", { name: "Agents", exact: true }).click();
  const newAgent = page.getByRole("toolbar", { name: "Agents controls", exact: true }).getByRole("button", { name: "New Agent", exact: true });
  await expect(newAgent).toHaveCount(1);
  await newAgent.click();
  await input.phase("agent_creation");
  const nameDialog = page.getByRole("dialog", { name: "Meet your next agent", exact: true });
  await expect(nameDialog.getByRole("button", { name: "Choose adapter", exact: true })).toBeDisabled();
  await nameDialog.getByRole("textbox", { name: "Agent name", exact: true }).fill(resources.agentName);
  const draft = await captureAntigravityAgentDraft(page, resources, input.persistResources,
    () => nameDialog.getByRole("button", { name: "Choose adapter", exact: true }).click(), config.savedConnection.ownerUserId);
  resources.agentId = draft.id; evidence.agentId = draft.id; evidence.cleanup.agent = false;
  await input.persistResources();
  await input.phase("picker_selection");
  await selectAntigravityFromOrdinaryPicker(page);
  await checkpoint("ordinary_picker");
  await page.getByRole("dialog", { name: "Choose an adapter", exact: true }).getByRole("button", { name: "Configure agent", exact: true }).click();
  await input.phase("saved_subscription");
  const saved = page.getByRole("combobox", { name: "Saved subscription", exact: true });
  await expect(saved).toBeVisible({ timeout: 60_000 });
  await saved.selectOption(`ai:${connection.grantId}`);
  await expect(saved).toHaveValue(`ai:${connection.grantId}`);
  await expect(saved.locator("option:checked")).toHaveText(`${connection.name} (Your default)`);
  await page.getByRole("button", { name: "Use saved subscription", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Configure your agent", exact: true })).toBeVisible({ timeout: 120_000 });
  await checkpoint("saved_subscription");
  await input.phase("model_selection");
  const model = page.getByRole("combobox", { name: "Model", exact: true });
  await expect(model).not.toHaveAttribute("aria-busy", "true", { timeout: 60_000 });
  // Select a catalog option. A custom model shortcut would miss exact account discovery.
  await expect(model.locator(`option[value="${ANTIGRAVITY_JOURNEY_MODEL}"]`)).toHaveCount(1);
  await model.selectOption(ANTIGRAVITY_JOURNEY_MODEL);
  await expect(model).toHaveValue(ANTIGRAVITY_JOURNEY_MODEL);
  const environmentSelect = page.getByRole("combobox", { name: "Environment", exact: true });
  const selectedEnvironment = await environmentSelect.inputValue();
  // Empty means the instance default; do not silently replace the selected environment.
  if (selectedEnvironment && selectedEnvironment !== environment.id) throw new ConnectionFailure("ui_environment_mismatch");
  await checkpoint("exact_model");
  await input.phase("setup_probe");
  const beforeProbe = await api.get<Row[]>(`/api/companies/${company.id}/heartbeat-runs?agentId=${draft.id}&limit=100`);
  if (beforeProbe.length) throw new ConnectionFailure("new_agent_already_has_runs");
  const probeResponse = page.waitForResponse(response => response.request().method() === "POST"
    && new URL(response.url()).pathname === `/api/companies/${company.id}/adapters/paperclip_runner/test-environment`, { timeout: 120_000 });
  resources.setupProbe = "pending";
  await input.persistResources();
  await page.getByRole("button", { name: "Run test", exact: true }).click();
  const probe = await probeResponse, result = await probe.json();
  if (!probe.ok() || result.status !== "pass" || !result.checks?.some((check: Row) => check.code === "antigravity_metadata_verified" && check.level === "info")
    || (await api.get<Row[]>(`/api/companies/${company.id}/heartbeat-runs?agentId=${draft.id}&limit=100`)).length)
    throw new ConnectionFailure("prompt_free_native_setup_test_failed");
  resources.setupProbe = "retired";
  await input.persistResources();
  await expect(page.getByText("Connection successful", { exact: true })).toBeVisible();
  await checkpoint("setup_probe");
  await input.phase("readiness");
  await page.getByRole("button", { name: "Finish setup", exact: true }).click();
  await assertAntigravityReady(page, resources.agentName);
  const ready = await api.get<Row>(`/api/agents/${draft.id}`);
  if (ready.companyId !== company.id || ready.name !== resources.agentName || ready.status !== "idle" || ready.lifecycleState !== "ready"
    || ready.adapterType !== "paperclip_runner" || ready.adapterConfig?.provider !== "acpx" || ready.adapterConfig?.acpxAgent !== "antigravity"
    || ready.adapterConfig?.model !== ANTIGRAVITY_JOURNEY_MODEL || ready.runtimeConfig?.aiConnection?.mode !== "responsible_user"
    || ready.runtimeConfig.aiConnection.provider !== "google" || ready.runtimeConfig.aiConnection.method !== "subscription")
    throw new ConnectionFailure("saved_ready_agent_binding_mismatch");
  const effectiveEnvironment = ready.defaultEnvironmentId ?? (await api.get<Row>("/api/instance/settings")).defaultEnvironmentId;
  if (effectiveEnvironment && effectiveEnvironment !== environment.id) throw new ConnectionFailure("saved_agent_environment_mismatch");
  // Preserve the operator's inherited accounting policy, as in the source journey.
  await checkpoint("agent_ready");
  await input.phase("first_composer");
  await page.getByRole("button", { name: `Assign ${resources.agentName} a Task`, exact: true }).click();
  await assertAntigravityCleanComposer(page, resources.agentName, ANTIGRAVITY_JOURNEY_MODEL);
  await checkpoint("clean_composer");
  await input.phase("close_empty_composer");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "New task", exact: true })).toBeHidden();
  await input.phase("agent_navigation");
  await openAntigravityAgentFromRoster(page, resources.agentName);
  await input.phase("instructions");
  await page.getByRole("navigation", { name: `${resources.agentName} navigation`, exact: true })
    .getByRole("link", { name: "Instructions", exact: true }).click();
  await page.getByRole("group", { name: "Instruction file view", exact: true }).getByRole("button", { name: "edit", exact: true }).click();
  const editor = page.locator('[contenteditable="true"]:visible,textarea[aria-label="Instruction file editor"]:visible');
  await expect(editor).toHaveCount(1);
  const current = await editor.evaluate(element => element instanceof HTMLTextAreaElement ? element.value : (element as HTMLElement).innerText);
  if (!current.includes("You are an agent in a Paperclip company.")) throw new ConnectionFailure("default_instructions_missing");
  const addition = `\nFor file verification tasks, your configured verification marker is:\n${marker}\n\nWhen a task asks for your configured verification marker, write exactly that marker as the first line of the requested proof file followed by one newline. Read the actual file back and attach it as the task result.`;
  // Follow the existing instruction-persistence journey's keyboard path. The
  // rich editor distinguishes real interaction from initial normalization.
  await editor.click();
  await editor.press("ControlOrMeta+End");
  for (const line of addition.split("\n")) {
    await editor.press("Enter");
    if (line) await editor.pressSequentially(line);
  }
  const save = page.getByRole("button", { name: "Save changes", exact: true });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(save).toBeDisabled({ timeout: 30_000 });
  const storedInstructions = await api.get<Row>(`/api/agents/${draft.id}/instructions-bundle/file?path=AGENTS.md&companyId=${company.id}`);
  if (!storedInstructions.content?.includes(marker) || !storedInstructions.content.includes(current.trim())) throw new ConnectionFailure("instruction_ui_save_not_durable");
  await checkpoint("instructions_saved");
  await input.phase("task_creation");
  await page.getByRole("button", { name: "Assign Task", exact: true }).click();
  await assertAntigravityCleanComposer(page, resources.agentName, ANTIGRAVITY_JOURNEY_MODEL);
  const prompt = "Create a proof file from your configured instruction\n\nCreate antigravity-proof.txt containing exactly your configured verification marker as its only line, followed by one newline. Read back the actual file, attach it as the task result, report its byte count, and complete this task. I will follow up to ask you to update this same file.";
  if (prompt.includes(marker)) throw new ConnectionFailure("instruction_nonce_leaked_to_task_prompt");
  const dialog = page.getByRole("dialog", { name: "New task", exact: true });
  await dialog.getByRole("textbox", { name: "editable markdown", exact: true }).fill(prompt);
  await input.beforeAdmission();
  const issueResponse = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/companies/${company.id}/issues`);
  await dialog.getByRole("button", { name: "Create task", exact: true }).click();
  const response = await issueResponse;
  if (response.status() !== 201) throw new ConnectionFailure("task_creation_failed");
  const issue = await response.json();
  if (issue.companyId !== company.id || issue.assigneeAgentId !== draft.id || typeof issue.id !== "string" || issue.description?.includes(marker)) throw new ConnectionFailure("task_creation_binding_mismatch");
  resources.issueId = issue.id; resources.issueIdentifier = issue.identifier;
  evidence.cleanup.runs = false;
  await input.persistResources();
  await expect(dialog).toBeHidden();
  // Follow the persistent created-task link, as the walkthrough does.
  await openAntigravityCreatedTask(page, issue);
  const verifyTurn = async (expectedBytes: Buffer, afterRunIds: readonly string[]) => verifyAntigravityJourneyTurn({ api, companyId: company.id,
    agentId: draft.id, issueId: issue.id, connectionId: connection.id, environmentId: environment.id, model: ANTIGRAVITY_JOURNEY_MODEL,
    expectedProfileDigest: config.candidate.profileDigest, expectedBytes, afterRunIds, deadlineAt: Date.now() + config.limits.turnTimeoutMs, observeRun: input.observeRun, assertActive: input.assertActive });
  await input.phase("first_turn");
  const first = await verifyTurn(firstBytes, []);
  evidence.turnEvidence.push(first);
  await checkpoint("first_run");
  await assertAntigravityTaskDone(page);
  await assertAntigravityFileActivity(page, first.runId);
  await inspectAntigravityArtifact(page, first.artifact.attachmentId, firstBytes);
  await checkpoint("first_artifact");
  await page.reload();
  await assertAntigravityTaskDone(page);
  await inspectAntigravityArtifact(page, first.artifact.attachmentId, firstBytes);
  await input.phase("followup");
  await input.beforeAdmission();
  await submitTaskReply(page, `Read your existing antigravity-proof.txt. Preserve its first line exactly and append this second line followed by one newline:\n${followupMarker}\nRead back the actual updated file, attach it as the task result, report its byte count, and complete this task. Do not recreate the original first line from memory or from a task message.`);
  const second = await verifyTurn(followupBytes, [first.runId]);
  evidence.turnEvidence.push(second);
  await checkpoint("followup_run");
  await assertAntigravityTaskDone(page);
  await assertAntigravityFileActivity(page, second.runId);
  await inspectAntigravityArtifact(page, second.artifact.attachmentId, followupBytes);
  await checkpoint("followup_artifact");
  await page.reload();
  await assertAntigravityTaskDone(page);
  await inspectAntigravityArtifact(page, second.artifact.attachmentId, followupBytes);
  await checkpoint("persisted");
}
