import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect } from "@playwright/test";
import { mcpInvitation, mcpSetupUrl } from "../../packages/shared/src/mcp-setup.js";
import { pollUntil } from "./api.js";
import { mcp, oauthPost, origin, resource, type Tokens, type Document, type Run } from "./public-mcp-client.js";
import { runAssistant, type AssistantTool, type AssistantTurn } from "./public-mcp-model.js";
import { gradeDelegation, gradeReportRetrieval, gradeInvitation, describesInvitationLimitation } from "./public-mcp-grading.js";
import type { runPublicMcpFlow } from "./public-mcp-flow.js";

/** A real MCP host owned by the evaluation harness, with explicit installation
 * tools. This evaluates invitation comprehension, not a vendor desktop UI.
 * No Paperclip transport or tool exists until a browser approves device OAuth. */
export async function runPublicMcpInvitationFlow(input: Parameters<typeof runPublicMcpFlow>[0]) {
  const { page, api, fixtures, execution, nonce } = input;
  const team = fixtures.company;
  const kind = execution.task.id;
  const chatHandoff = kind === "invitation-cold-start";
  const denied = kind === "invitation-denied", unavailable = kind === "invitation-unavailable-host";
  const negative = denied || unavailable;
  const directory = await mkdtemp(path.join(os.tmpdir(), "paperclip-invitation-host-"));
  const configPath = path.join(directory, "mcp.json");
  const existing = kind === "invitation-existing-config" ? { notes: { url: "https://notes.example/mcp", enabled: false } } : {};
  await writeFile(configPath, JSON.stringify(existing), { mode: 0o600 });
  let client: Awaited<ReturnType<typeof mcp>> | undefined;
  let tokens: Tokens | undefined, clientId = "", deviceCode = "", verificationUrl = "";
  let fetched = false, configured = false, approved = false, configurationWrites = 0;
  let userCode = "", decided = false;
  const humanDecisions: Array<{ afterTurn: number; decision: "approved" | "declined"; verificationUrl: string }> = [];
  const turns: AssistantTurn[] = [], checks: Array<{ id: string; passed: boolean; detail: string }> = [];
  const check = (id: string, passed: boolean, detail: string) => checks.push({ id, passed, detail });
  const tasks = () => api.get<any[]>(`/api/companies/${team.id}/issues?limit=100`);
  const connections = () => api.get<Array<{ id: string; companyId: string; revokedAt: string | null }>>("/api/mcp/connections");
  const beforeGrants = await connections();
  const title = execution.task.buildTitle(nonce), marker = execution.task.buildVisibleMarker(nonce);
  let issue: any, runs: any[] = [];
  const hostTool = (name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []): AssistantTool => ({ name, description, inputSchema: { type: "object", properties, required, additionalProperties: false } });
  const urlProperty = { url: { type: "string" } };
  const hostTools = [
    hostTool("fetch_setup_instructions", "Read the public Paperclip invitation instructions from its URL. This does not install or authorize anything.", urlProperty, ["url"]),
    hostTool("inspect_mcp_configuration", "Inspect this host's existing MCP server configuration and setup capabilities."),
    hostTool("configure_paperclip_mcp", "Configure this evaluation host's Paperclip MCP endpoint, preserving other servers. Does not authorize access. The host supports device authorization and refresh without a restart.", urlProperty, ["url"]),
    hostTool("start_paperclip_authorization", "Start device authorization for the configured server and obtain a human verification URL. Never receives tokens in model context."),
    hostTool("request_user_approval", "Present the exact verification URL to the human and wait for their browser decision. Only a human approval makes the Paperclip tools available. Never retry a rejection.", urlProperty, ["url"]),
  ].filter(tool => !chatHandoff || tool.name !== "request_user_approval");
  const toolCall = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    if (name === "fetch_setup_instructions") {
      const expected = mcpSetupUrl(resource, team.id);
      if (args.url !== expected && args.url !== expected.replace("/mcp/setup?", "/mcp/setup.md?")) return { error: "Use the invitation's setup URL." };
      const response = await fetch(String(args.url), { headers: { Accept: "text/markdown" }, redirect: "error" });
      if (!response.ok) throw new Error(`Public setup fetch failed: HTTP ${response.status}`);
      fetched = true; return { markdown: await response.text() };
    }
    if (name === "inspect_mcp_configuration") return { servers: JSON.parse(await readFile(configPath, "utf8")), canConfigure: !unavailable, supportsDeviceAuthorization: !unavailable, restartRequired: false };
    if (name === "configure_paperclip_mcp") {
      if (unavailable) return { error: "This browser host cannot install or authorize MCP connections from chat. The user must add the server in their connector settings. No Paperclip tools are available." };
      if (!fetched || args.url !== resource) return { error: "Read the invitation and use its exact MCP endpoint first." };
      if (!configured) { await writeFile(configPath, JSON.stringify({ ...existing, paperclip: { url: resource } })); configurationWrites++; configured = true; }
      return { configured: true, authorized: false, restartRequired: false };
    }
    if (name === "start_paperclip_authorization") {
      if (!configured || unavailable) return { error: "Configure a supported host first." };
      if (verificationUrl) return { verificationUrl, userCode };
      const registration = await oauthPost("register", { client_name: "Invitation evaluation host", redirect_uris: [], response_types: [], grant_types: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"] });
      expect(registration.status).toBe(201); clientId = (await registration.json()).client_id;
      const response = await oauthPost("device_authorization", { client_id: clientId, resource, company_id: team.id, scope: "paperclip:read paperclip:write offline_access" });
      expect(response.status).toBe(200);
      const body = await response.json(); deviceCode = body.device_code; input.secrets.push(deviceCode);
      userCode = body.user_code; verificationUrl = body.verification_uri_complete;
      return { verificationUrl, userCode, message: chatHandoff ? "Give the human this URL and wait for their reply. Access is pending." : "Give the human this URL using request_user_approval. Access is pending." };
    }
    if (name === "request_user_approval") {
      if (!verificationUrl || args.url !== verificationUrl || decided) return { error: "Use the pending verification URL exactly once." };
      return await humanDecision();
    }
    if (!client) return { error: "No authorized Paperclip connection exists." };
    return client.call(name, args);
  };
  const humanDecision = async () => {
    if (decided) throw new Error("The human decision was already recorded.");
    decided = true;
    await page.goto(verificationUrl);
    await expect(page.getByRole("heading", { name: /^Connect .+ to Paperclip$/ })).toBeVisible();
    await expect(page.getByText(team.name, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: denied ? "Cancel" : "Connect organization", exact: true }).click();
    await expect(page.getByRole("heading", { name: denied ? "Connection declined" : "Access approved" })).toBeVisible();
    const response = await oauthPost("token", { grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: clientId, resource, device_code: deviceCode });
    if (denied) { expect(response.status).toBe(400); expect((await response.json()).error).toBe("access_denied"); return { decision: "declined", message: "The human declined access. Do not retry or bypass this decision." }; }
    expect(response.status).toBe(200); tokens = await response.json() as Tokens;
    input.secrets.push(tokens.access_token, tokens.refresh_token); approved = true;
    client = await mcp(tokens);
    return { decision: "approved", message: "The user approved in their browser. Paperclip tools are now available; verify identity and organization before doing work." };
  };
  const converse = (prompt: string, connected = false) => runAssistant({ usage: input.usage, credential: input.credential, prompt,
    system: connected ? "You are using this host's previously authorized Paperclip connection." : "You are in a fresh assistant session. No Paperclip MCP connection or tools are installed. Use your host's setup tools to follow the user's invitation. Respect missing host capabilities and declined consent. Never claim reading instructions installs a connection.",
    tools: async () => [...(!connected ? hostTools : []), ...(client ? (await client.list()).tools : [])], call: toolCall,
    deadlineAt: Math.min(input.deadlineAt - 60_000, Date.now() + 240_000),
    observe: async turn => { if (!turns.includes(turn)) turns.push(turn); await input.evidence("public-mcp-assistant.json", { usage: input.usage, turns, checks, humanDecisions }); },
  });
  try {
    // Negative cases still use one independently created worker fixture to retain
    // the suite's worker billing/terminal-state contract; it is not assistant work.
    if (negative) issue = await api.post(`/api/companies/${team.id}/issues`, { title, description: execution.task.buildPrompt(nonce), status: "todo", assigneeAgentId: fixtures.agent.id });
    const invitation = mcpInvitation(resource, { id: team.id, name: team.name });
    const workRequest = `After approval, verify the connected person and organization, then delegate exactly one task titled "${title}" to "${fixtures.agent.name}": ${execution.task.buildPrompt(nonce)} I authorize its execution budget. If setup is unavailable or I decline, stop and explain the next step; do not change any work.`;
    let answer = await converse(`${invitation}\n${workRequest}`);
    // A plain-text approval link is also a valid human handoff. The harness
    // approves/declines through the real browser, then sends a separate human
    // turn. This is recorded as a host event, never invented as a model call.
    if (!unavailable && verificationUrl && !decided && answer.final.includes(verificationUrl)) {
      const decision = await humanDecision();
      humanDecisions.push({ afterTurn: turns.length - 1, decision: decision.decision as "approved" | "declined", verificationUrl });
      answer = await converse(denied ? "I declined the connection. Stop; do not retry or change work." : `I approved the connection in Paperclip. ${workRequest}`, approved);
    }
    const savedConfig = JSON.parse(await readFile(configPath, "utf8"));
    const grants = (await connections()).filter(grant => !beforeGrants.some(old => old.id === grant.id) && !grant.revokedAt);
    const invitationEvidence = { kind, companyId: team.id, fetched, configured, approved, configurationWrites, existingPreserved: Object.entries(existing).every(([name, value]) => JSON.stringify(savedConfig[name]) === JSON.stringify(value)), grants, turns, humanDecisions };
    await input.evidence("public-mcp-invitation.json", { host: "evaluation-owned MCP host; vendor clients verified separately", initialPaperclipTools: 0, fixtureWorker: negative, ...invitationEvidence });
    check("invitation-authority", gradeInvitation(invitationEvidence), "Public instructions, isolated host configuration and independently listed grants establish the actual approval boundary.");
    if (negative) check("honest-setup-limitation", describesInvitationLimitation(answer.final), "The assistant describes the observed refusal or unsupported host.");
    if (!negative) expect((await tasks()).filter(task => task.title === title), "The assistant must delegate after the actual human decision").toHaveLength(1);
    await pollUntil({ label: "invitation workflow durable completion", deadlineAt: input.deadlineAt - 90_000, intervalMs: 1000,
      load: async () => {
        const found = (await tasks()).filter(task => task.title === title); issue = found[0];
        runs = issue ? (await api.get<Array<Run & { runId: string }>>(`/api/issues/${issue.id}/runs`)).map(run => ({ ...run, id: run.runId })) : [];
        if (issue) input.observe(issue, runs); return { found, runs };
      }, accept: value => value.found.length === 1 && value.found[0].status === "done" && value.runs.length === 1 && value.runs[0]?.status === "succeeded",
      reject: value => value.found.length > 1 || value.runs.length > 1 ? "duplicate work" : value.runs.some(run => ["failed", "cancelled", "timed_out"].includes(run.status)) ? "worker execution failed" : undefined,
    });
    const document = await api.get<Document>(`/api/issues/${issue.id}/documents/report`);
    for (const result of gradeDelegation({ expected: { companyId: team.id, agentId: fixtures.agent.id, title, marker }, tasks: await tasks(), runs, document })) check(result.id, result.passed, "Independent task, run and agent-authored report observations.");
    if (!negative) {
      if (kind === "invitation-reconnect") { await client!.close(); client = await mcp(tokens!); }
      const later = await converse(`Find "${title}" and quote its saved report, including its reference. Do not create or change work.`, true);
      check("later-report-retrieved", gradeReportRetrieval({ companyId: team.id, taskId: issue.id, marker, ...later }), "A separate paid conversation reads the persisted result without setup or new consent.");
    }
    runs = await Promise.all(runs.map(run => api.get<any>(`/api/heartbeat-runs/${run.id}`)));
    check("paid-worker-model", runs.length === 1 && runs[0]?.usageJson?.model === execution.profile.model && runs[0]?.runtimeMode === execution.profile.expectedRuntimeMode, "The independently metered worker matches the selected profile.");
    input.observe(issue, runs);
    await page.goto(origin + `/${team.issuePrefix}/issues/${issue.identifier ?? issue.id}`);
    await expect(page.getByText(marker, { exact: false }).first()).toBeVisible();
    await input.capture("public-mcp-invitation-result", "Invitation workflow durable task", "final-state.png");
    await input.evidence("api-state.json", { issue, runs, checks });
    expect(checks.filter(check => !check.passed), "Invitation independent oracle").toEqual([]);
    return { issue, runs, checks };
  } finally {
    await client?.close();
    if (tokens) { const response = await oauthPost("revoke", { client_id: clientId, token: tokens.refresh_token }); expect(response.ok).toBe(true); }
    await input.evidence("public-mcp-assistant.json", { usage: input.usage, turns, checks, humanDecisions });
    await rm(directory, { recursive: true, force: true });
  }
}
