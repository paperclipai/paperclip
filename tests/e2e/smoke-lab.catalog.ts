export type SmokeRunStepPath = "P1" | "P2" | "P3" | "P4" | "P5" | "P6" | "P7";

export type SmokeLabScenarioStatus = "ci_safe" | "headed_full";

export type SmokeLabTransport = "mcp_remote" | "local_stdio" | "plugin" | "prosumer_import" | "gateway_session" | "governance";

export interface SmokeLabLifecycleTool {
  name: string;
  parameters: Record<string, unknown>;
}

export interface SmokeLabScenario {
  path: SmokeRunStepPath;
  title: string;
  transport: SmokeLabTransport;
  authMode: "oauth" | "api_key" | "none" | "plugin_install" | "config_import" | "run_scoped_token" | "policy";
  smokeService: string;
  status: SmokeLabScenarioStatus;
  ciSafe: boolean;
  uiEntryPath: "apps" | "advanced" | "review" | "activity" | "attention";
  lifecycle: {
    connect: string;
    discoverCatalog: string;
    allowedRead: SmokeLabLifecycleTool;
    askFirstWrite: SmokeLabLifecycleTool;
    deniedCall: SmokeLabLifecycleTool;
    schemaChangeQuarantine: SmokeLabLifecycleTool;
    revoke: string;
    auditEvidence: string;
  };
}

const httpLifecycle = {
  allowedRead: { name: "todo.list", parameters: {} },
  askFirstWrite: { name: "todo.add", parameters: { title: "Smoke Lab approved write" } },
  deniedCall: { name: "email.send", parameters: { to: "smoke@example.test", subject: "Denied", body: "Denied smoke call" } },
  schemaChangeQuarantine: { name: "fixture.schemaFlip", parameters: { toolName: "kv.set" } },
};

const stdioLifecycle = {
  allowedRead: { name: "time.now", parameters: {} },
  askFirstWrite: { name: "slow.ping", parameters: { delayMs: 1 } },
  deniedCall: { name: "crash.now", parameters: {} },
  schemaChangeQuarantine: { name: "malicious.metadata", parameters: {} },
};

export const smokeLabScenarios: SmokeLabScenario[] = [
  {
    path: "P1",
    title: "Remote HTTP MCP connection, OAuth",
    transport: "mcp_remote",
    authMode: "oauth",
    smokeService: "HTTP MCP fixture + fake OAuth provider",
    status: "ci_safe",
    ciSafe: true,
    uiEntryPath: "apps",
    lifecycle: {
      connect: "Start fake OAuth and HTTP MCP fixture services, then use the installed HTTP fixture connection as the OAuth-backed remote MCP path.",
      discoverCatalog: "Verify the HTTP fixture catalog is visible through Paperclip.",
      ...httpLifecycle,
      revoke: "Disable the active fixture connection and re-enable it for subsequent catalog paths.",
      auditEvidence: "Activity and gateway audit rows show the allowed, approved, denied, quarantine, and revoke decisions.",
    },
  },
  {
    path: "P2",
    title: "Remote HTTP MCP connection, API key",
    transport: "mcp_remote",
    authMode: "api_key",
    smokeService: "HTTP MCP fixture with static fixture credential",
    status: "ci_safe",
    ciSafe: true,
    uiEntryPath: "apps",
    lifecycle: {
      connect: "Install the HTTP fixture with fixture credential metadata.",
      discoverCatalog: "Verify API-key-backed HTTP fixture catalog entries.",
      ...httpLifecycle,
      revoke: "Disable the active fixture connection and re-enable it for subsequent catalog paths.",
      auditEvidence: "Audit rows preserve API-key path decisions without exposing the credential.",
    },
  },
  {
    path: "P3",
    title: "Local stdio MCP template",
    transport: "local_stdio",
    authMode: "none",
    smokeService: "stdio MCP fixture template",
    status: "ci_safe",
    ciSafe: true,
    uiEntryPath: "advanced",
    lifecycle: {
      connect: "Install the approved stdio template fixture.",
      discoverCatalog: "Verify template catalog entries are visible.",
      ...stdioLifecycle,
      revoke: "Disable the stdio fixture connection and re-enable it for subsequent catalog paths.",
      auditEvidence: "Runtime/activity evidence attributes stdio fixture decisions.",
    },
  },
  {
    path: "P4",
    title: "Plugin-provided integration",
    transport: "plugin",
    authMode: "plugin_install",
    smokeService: "Smoke Lab fixture application standing in for plugin-provided catalog",
    status: "ci_safe",
    ciSafe: true,
    uiEntryPath: "apps",
    lifecycle: {
      connect: "Exercise the catalog-backed app install path used by plugin-provided integrations.",
      discoverCatalog: "Verify plugin-style application catalog entries are visible.",
      ...stdioLifecycle,
      revoke: "Disable the plugin-style fixture connection and re-enable it for subsequent catalog paths.",
      auditEvidence: "Activity rows preserve app install and lifecycle decisions.",
    },
  },
  {
    path: "P5",
    title: "Paste-a-config / run-your-own import",
    transport: "prosumer_import",
    authMode: "config_import",
    smokeService: "HTTP MCP fixture imported through advanced configuration",
    status: "ci_safe",
    ciSafe: true,
    uiEntryPath: "advanced",
    lifecycle: {
      connect: "Exercise the advanced run-your-own configuration surface with the HTTP fixture.",
      discoverCatalog: "Verify imported configuration catalog entries.",
      ...httpLifecycle,
      revoke: "Disable the imported fixture connection and re-enable it for subsequent catalog paths.",
      auditEvidence: "Advanced activity rows show import and governed calls.",
    },
  },
  {
    path: "P6",
    title: "Token broker / gateway session",
    transport: "gateway_session",
    authMode: "run_scoped_token",
    smokeService: "Tool gateway session over Smoke Lab HTTP fixture",
    status: "ci_safe",
    ciSafe: true,
    uiEntryPath: "activity",
    lifecycle: {
      connect: "Create a run-scoped gateway session for a smoke agent.",
      discoverCatalog: "List gateway-visible tools through the session token.",
      ...httpLifecycle,
      revoke: "Revoke the gateway session and verify the token is cut off.",
      auditEvidence: "Gateway audit rows show session creation, discovery, calls, and revocation.",
    },
  },
  {
    path: "P7",
    title: "Governance surfaces",
    transport: "governance",
    authMode: "policy",
    smokeService: "Profiles, ask-first policies, block policies, and quarantine fixtures",
    status: "ci_safe",
    ciSafe: true,
    uiEntryPath: "review",
    lifecycle: {
      connect: "Install fixture connections and profile bindings.",
      discoverCatalog: "Verify profile-governed catalog entries.",
      ...httpLifecycle,
      revoke: "Revoke the temporary trust/policy changes.",
      auditEvidence: "Review and Activity expose ask-first, block, quarantine, and revoke evidence.",
    },
  },
];

export function smokeLabScenarioByPath(path: SmokeRunStepPath): SmokeLabScenario {
  const scenario = smokeLabScenarios.find((candidate) => candidate.path === path);
  if (!scenario) throw new Error(`Unknown Smoke Lab scenario path: ${path}`);
  return scenario;
}

export const ciSmokeLabScenarios = smokeLabScenarios.filter((scenario) => scenario.ciSafe);
