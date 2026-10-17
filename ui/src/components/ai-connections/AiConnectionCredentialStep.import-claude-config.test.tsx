// @vitest-environment jsdom

/**
 * The gate in front of the import credential mode, as the surface that owns the
 * wiring decides it.
 *
 * `AiConnectionCredentialStep` is where the facts that the mode needs are
 * gathered: which provider the connection will be, and whether the instance is
 * the kind that reads local credentials. It hands the shared provider step its
 * answer as `importCapable`, and a surface that draws the mode nobody could
 * complete is worse than one that does not draw it (PRODUCT #4, #49).
 *
 * The gate is the one all four surfaces share (`canOfferClaudeConfigImport`), so
 * the provider and instance halves are asserted here as the chain rather than as a
 * line only this surface owns. Nothing here asks about the execution environment
 * the agent resolves to: whether the gateway is reachable from there is the
 * server's judgement (PRODUCT #51, #53), and this suite asserts both halves of
 * that — the mode stays drawn, and the server's refusal is the sentence shown.
 */

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { AiConnectionCredentialStep } from "./AiConnectionCredentialStep";
import {
  GATEWAY,
  UNREACHABLE_ENVIRONMENT_422,
  environmentFixture,
  locallyTrustedHealth,
  readOk,
} from "./import-claude-config-fixtures";

const managedApi = vi.hoisted(() => ({
  list: vi.fn(async () => ({ currentUserId: "user-1", connections: [] })),
  loginResult: vi.fn(),
  connectLocal: vi.fn(),
  startLocalLogin: vi.fn(),
  checkLocalLogin: vi.fn(async () => ({ status: "connected" })),
  cancelLocalLogin: vi.fn(),
  create: vi.fn(),
  readLocalClaudeConfig: vi.fn(),
  importLocalClaudeConfig: vi.fn(),
}));
vi.mock("@/api/ai-connections", () => ({ aiConnectionsApi: managedApi }));

const environmentsApi = vi.hoisted(() => ({ list: vi.fn(), capabilities: vi.fn() }));
vi.mock("@/api/environments", () => ({ environmentsApi }));

const settingsApi = vi.hoisted(() => ({ get: vi.fn(), getExperimental: vi.fn(), getGeneral: vi.fn() }));
vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: settingsApi }));

const healthApi = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/api/health", () => ({ healthApi }));

const agentsApi = vi.hoisted(() => ({
  adapterModels: vi.fn(async () => [] as Array<{ id: string; label: string }>),
  getAdapterAuthSignal: vi.fn(async () => ({ status: "present" })),
  getClaudeOAuthTokenStatus: vi.fn(async () => { throw new ApiError("Not found", 404, null); }),
}));
vi.mock("@/api/agents", () => ({ agentsApi }));
vi.mock("@/api/secrets", () => ({
  secretsApi: { listMyUserSecrets: vi.fn(async () => []), list: vi.fn(async () => []) },
}));
// The sign-in panel is the other two modes' business and drags the whole login
// controller into this render; the import mode never reaches it.
vi.mock("../AdapterConfigForm", () => ({ AdapterLoginPanel: () => <div>Browser sign-in</div> }));

let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
afterEach(() => {
  flushSync(() => root?.unmount());
  host?.remove();
  client?.clear();
  vi.clearAllMocks();
});

type MountOptions = {
  provider?: "anthropic" | "openai" | "xai" | "openrouter";
  driver?: "local" | "ssh" | "sandbox";
  health?: Record<string, unknown>;
  read?: unknown;
};

/** Stand the step up over one environment row and one health answer. */
async function mount({
  provider = "anthropic",
  driver = "local",
  health = locallyTrustedHealth(),
  read = readOk(),
}: MountOptions = {}) {
  healthApi.get.mockResolvedValue(health);
  environmentsApi.list.mockResolvedValue([environmentFixture(driver)]);
  environmentsApi.capabilities.mockResolvedValue({ sandboxProviders: {} });
  settingsApi.get.mockResolvedValue({ defaultEnvironmentId: `env-${driver}` });
  settingsApi.getExperimental.mockResolvedValue({ enableManagedSandboxOnly: false });
  settingsApi.getGeneral.mockResolvedValue({ executionMode: "any" });
  managedApi.readLocalClaudeConfig.mockResolvedValue(read);
  managedApi.importLocalClaudeConfig.mockResolvedValue({ connectionId: "imported", grantId: "imported-grant" });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  flushSync(() =>
    root.render(
      <QueryClientProvider client={client}>
        <AiConnectionCredentialStep
          companyId="c1"
          provider={provider}
          name="My Claude account"
          ownership="personal"
          agentIds={[]}
          allAgents
          environmentId={`env-${driver}`}
          onComplete={vi.fn()}
          onCancel={vi.fn()}
        />
      </QueryClientProvider>,
    ),
  );
  // The step prepares its environments before it draws anything, and a gate read
  // off a payload that has not landed is not the gate under test.
  await vi.waitFor(() => expect(client.isFetching()).toBe(0));
  if (provider === "openrouter") {
    await vi.waitFor(() => expect(host.textContent).toContain("OpenRouter"));
  } else {
    // The provider step is what the gate is drawn on, so wait for it rather than
    // for the step's own loading notice.
    await vi.waitFor(() =>
      expect(host.querySelector('[role="radiogroup"]')?.getAttribute("aria-label")).toBe(
        "Connect your model provider",
      ),
    );
  }
  return host;
}

/** The credential-mode switch, which is a button naming where a press goes. */
function modeLink() {
  return [...host.querySelectorAll("button")].find((node) => node.textContent?.includes("instead"))!;
}

/** Walk the switch through every mode it offers. */
function walkEveryMode() {
  for (let press = 0; press < 3; press++) {
    if (!modeLink()) return;
    flushSync(() => modeLink().click());
  }
}

/** Press the switch until the import mode is in force, which is what reads. */
async function enterImportMode() {
  const reads = managedApi.readLocalClaudeConfig.mock.calls.length;
  for (let press = 0; press < 3; press++) {
    flushSync(() => modeLink().click());
    if (managedApi.readLocalClaudeConfig.mock.calls.length > reads) return;
    await Promise.resolve();
  }
  await vi.waitFor(() =>
    expect(managedApi.readLocalClaudeConfig.mock.calls.length).toBeGreaterThan(reads),
  );
}

/** The credential tag the tiles carry — the steady-state name of the mode. */
function credentialTag() {
  return host.querySelector('[role="radio"]')?.textContent ?? "";
}

/** A button by its exact label, so the tiles and the mode switch are not mistaken for it. */
function button(text: string) {
  return [...host.querySelectorAll("button")].find((node) => node.textContent?.trim() === text)!;
}

/** The sentence the switch shows for the third mode. Absent when it is not offered. */
function offersImportMode() {
  return (host.textContent ?? "").includes("Use import from Claude config instead");
}

describe("AiConnectionCredentialStep: the import mode's gate", () => {
  it("offers the import mode for an Anthropic connection resolving to a local environment", async () => {
    await mount();
    // The control exists, and taking it reads the file (PRODUCT #9).
    expect(offersImportMode()).toBe(true);
    await enterImportMode();
    expect(managedApi.readLocalClaudeConfig).toHaveBeenCalledWith("c1");
    await vi.waitFor(() => expect(credentialTag()).toContain("Import"));
    await vi.waitFor(() => expect(host.textContent).toContain(GATEWAY));
  });

  it.each([
    ["an instance that has not opted into local sign-in", locallyTrustedHealth({ localAiLoginSupported: false })],
    ["a hosted instance", { status: "ok", deploymentMode: "authenticated", localAiLoginSupported: true }],
    ["an instance that reports no deployment mode at all", { status: "ok" }],
  ])("does not offer the import mode on %s", async (_label, health) => {
    // The instance half of the gate, read off the same health answer the local
    // sign-in reads (PRODUCT #4, #5, #43). The server enforces it again, so this
    // is the presentation half only — but a mode nobody could complete should
    // not be drawn (PRODUCT #49).
    await mount({ health });
    walkEveryMode();
    expect(offersImportMode()).toBe(false);
    expect(managedApi.readLocalClaudeConfig).not.toHaveBeenCalled();
    expect(managedApi.importLocalClaudeConfig).not.toHaveBeenCalled();
  });

  it.each(["sandbox", "ssh"] as const)(
    "still offers it when the agent resolves to %s, because the server judges reachability",
    async (driver) => {
      // The probe runs on the server, so it would say yes about a gateway this
      // agent could never reach — but that judgement needs the agent's driver and
      // its network allowlist, and this surface holds neither (PRODUCT #51, #53).
      // The mode stays drawn, and the server refuses with the reason; see the next
      // case for what the reader then sees.
      await mount({ driver });
      expect(offersImportMode()).toBe(true);
      await enterImportMode();
      expect(managedApi.readLocalClaudeConfig).toHaveBeenCalledWith("c1");
      expect(credentialTag()).toContain("Import");
    },
  );

  it("repeats the server's own answer when the gateway is out of reach for this agent", async () => {
    await mount();
    // A 422 is the server refusing for a reason of its own — here an execution
    // environment that cannot reach the gateway — so its sentence is the copy
    // rather than any guess this surface could make (PRODUCT #25, #51).
    managedApi.importLocalClaudeConfig.mockRejectedValue(
      new ApiError(UNREACHABLE_ENVIRONMENT_422.message, UNREACHABLE_ENVIRONMENT_422.status, null),
    );
    await enterImportMode();
    await vi.waitFor(() => expect(button("Import").disabled).toBe(false));
    flushSync(() => button("Import").click());
    await vi.waitFor(() =>
      expect(host.querySelector('[role="alert"]')?.textContent).toContain(UNREACHABLE_ENVIRONMENT_422.message),
    );
    // Nothing was built, and the snapshot is still on the card to retry with.
    expect(host.textContent).toContain(GATEWAY);
    flushSync(() => button("Import").click());
    await vi.waitFor(() => expect(managedApi.importLocalClaudeConfig).toHaveBeenCalledTimes(2));
  });

  it.each(["openai", "xai"] as const)("does not offer the import mode for %s", async (provider) => {
    // The provider half (PRODUCT #3): endpoint fields mean nothing on an adapter
    // whose provider has no gateway, so the step says so up front and the shared
    // step reads the same answer off the adapter it is given.
    await mount({ provider });
    walkEveryMode();
    expect(offersImportMode()).toBe(false);
    expect(managedApi.readLocalClaudeConfig).not.toHaveBeenCalled();
    expect(managedApi.importLocalClaudeConfig).not.toHaveBeenCalled();
  });

  it("keeps the two-mode switch for openrouter, which never reaches the shared step", async () => {
    // OpenRouter is the provider whose connections carry no sign-in at all, so
    // this surface answers with the plain API-key card rather than the provider
    // step. There is no third mode to offer and none is drawn.
    await mount({ provider: "openrouter" });
    expect(offersImportMode()).toBe(false);
    expect([...host.querySelectorAll("button")].some((node) => /instead/.test(node.textContent ?? ""))).toBe(false);
    expect(managedApi.readLocalClaudeConfig).not.toHaveBeenCalled();
    expect(managedApi.importLocalClaudeConfig).not.toHaveBeenCalled();
  });
});
