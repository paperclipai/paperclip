import { expect } from "@playwright/test";
import { createConnectionProof } from "../connection-evidence.js";
import { onboardingConnect } from "./onboarding-connect.js";
import { onboardingFirstTask } from "./onboarding-first-task.js";
import { JourneyError, type JourneyContext, type JourneyEvidence, type TargetSession } from "./types.js";

type Row = Record<string, any>;
export interface CloudOnboardingInput {
  page: JourneyContext["page"];
  campaignId: string;
  deadlineAt: number;
  gateway: { model: string; baseUrl: string; apiKey: string };
  maxRuns: number;
  evidence: JourneyEvidence;
  own: TargetSession["own"];
  beforeWorkspace(name: string): Promise<void>;
  workspaceCreated(): Promise<JourneyContext>;
  /** The saved route must pass a deny-only runtime probe before Connect can spend. */
  qualify(context: JourneyContext, connectionId: string): Promise<void>;
  verifyExecution(context: JourneyContext, runIds: string[]): Promise<void>;
  phase(phase: "setup" | "agent"): Promise<void>;
  observeRun(run: Row): Promise<void>;
}
/** Measured actions use normal Cloud and tenant controls; infrastructure stays in the provider. */
export async function cloudOnboarding(input: CloudOnboardingInput): Promise<JourneyContext> {
  const { page, evidence, campaignId } = input;
  const name = `Journey QA ${campaignId}`;
  const firstRunName = page.getByLabel("Name", { exact: true });
  const organizationName = page.getByLabel("Organization name", { exact: true });
  const createLink = page.getByRole("link", { name: /^(Create (?:a new )?organization|\+ New organization)$/ }).first();
  // The first organization uses the signup Name/Next form. Later organizations
  // use Organization name/Create organization, reached from the managed portfolio.
  await expect(firstRunName.or(organizationName).or(createLink).first()).toBeVisible();
  if (!await firstRunName.isVisible() && !await organizationName.isVisible()) {
    await createLink.click();
    await expect(organizationName).toBeVisible();
  }
  const firstRun = await firstRunName.isVisible();
  await (firstRun ? firstRunName : organizationName).fill(name);
  await input.beforeWorkspace(name);
  await page.getByRole("button", { name: firstRun ? "Next" : "Create organization", exact: true }).click();
  const context = await input.workspaceCreated();
  const { api, company } = context;
  evidence.deployment = context.identity;
  evidence.checks.push({ id: "fresh-workspace", passed: true });
  await input.phase("setup");
  await expect(page.getByRole("heading", { name: "Create your first agent", exact: true })).toBeVisible({ timeout: 180_000 });
  await input.own({ kind: "agent", name });
  await page.getByLabel("Agent name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("button", { name: "Use API key instead", exact: true }).click();
  await page.getByRole("radio", { name: /OpenAI.*API/ }).click();
  await page.getByRole("button", { name: "Use a custom gateway", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Custom gateway connection", exact: true });
  await dialog.getByLabel("Provider URL", { exact: true }).fill(input.gateway.baseUrl);
  await dialog.getByLabel("API key", { exact: true }).fill(input.gateway.apiKey);
  await dialog.getByRole("button", { name: "Change", exact: true }).click();
  await dialog.getByLabel("Model IDs", { exact: true }).fill(input.gateway.model);
  const connectionName = `My ${new URL(input.gateway.baseUrl).hostname}`;
  await input.own({ kind: "connection", name: connectionName });
  await dialog.getByRole("button", { name: "Save connection", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const connections = (await api.get(`/api/companies/${company.id}/ai-connections`)).connections as Row[];
  const connection = connections.find(c => c.name === connectionName && c.provider === "openai" && c.method === "api_key" && c.status === "connected");
  if (!connection || connections.length !== 1) throw new JourneyError("failed", "onboarding_connection_not_saved");
  await input.own({ kind: "connection", name: connectionName, id: connection.id });
  await page.getByRole("combobox", { name: "Model", exact: true }).selectOption(input.gateway.model);
  await page.locator("summary").filter({ hasText: "Advanced" }).click();
  await page.getByRole("button", { name: "Runner", exact: true }).click();
  await page.getByRole("option", { name: /^Paperclip Runner/ }).click();
  await input.qualify(context, connection.id);
  // Connect performs the production probe and agent creation. Never press Retry.
  const connect = await onboardingConnect({ page, origin: api.origin, companyId: company.id, deadlineAt: input.deadlineAt,
    retain: value => { evidence.onboardingConnect = value; } });
  const agents = await api.get<Row[]>(`/api/companies/${company.id}/agents`);
  const agent = agents.find(a => a.name === name);
  if (!agent || agents.length !== 1 || agent.adapterType !== "paperclip_runner" || agent.adapterConfig?.provider !== "codex" || agent.adapterConfig?.model !== input.gateway.model) throw new JourneyError("failed", "onboarding_agent_configuration_mismatch");
  connect.checkpoint = "agent-verification";
  await input.own({ kind: "agent", name, id: agent.id });
  evidence.checks.push({ id: "ui-connection-and-native-agent", passed: true });
  await input.own({ kind: "issue", name: "Paperclip onboarding" });
  await page.getByRole("button", { name: "Get started", exact: true }).click();
  await input.phase("agent");
  const completed = await onboardingFirstTask({ context, agent: { id: agent.id }, connectionId: connection.id,
    proof: createConnectionProof(), campaignId, maxRuns: input.maxRuns, deadlineAt: input.deadlineAt,
    own: input.own, observeRun: input.observeRun, onArtifact: artifact => { evidence.artifact = artifact; } });
  await input.verifyExecution(context, [completed.artifact.originatingRunId]);
  evidence.checks.push({ id: "first-task-complete", passed: true },
    { id: "downloadable-artifact-verified", passed: true }, { id: "native-trace-verified", passed: true });
  return { ...context, startingState: "onboarding" };
}
