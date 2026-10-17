// @vitest-environment jsdom

/**
 * The import credential mode on the shared provider step: reading the operator's
 * own `~/.claude/settings.json` from the machine running Paperclip, confirming it
 * on a card, and creating the connection through the dedicated import route.
 *
 * This is the mode the agent configuration page, the new-agent wizard and the Apps
 * catalog flow all reach through the same component (TECH design choice 7), so what
 * is asserted here is what those three surfaces get.
 */

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentProviderConnection } from "./AgentProviderConnection";
import { ApiError } from "@/api/client";
import {
  LOCAL_CLAUDE_SETTINGS_PATH,
  MODEL_TIER_VARIABLES,
  READ_UNAVAILABLE_MESSAGES,
  UNREACHABLE_ENVIRONMENT_422,
  readUnavailable,
} from "@/components/ai-connections/import-claude-config-fixtures";

const managedApi = vi.hoisted(() => ({
  list: vi.fn(async () => ({ currentUserId: "user-1", connections: [] })),
  loginResult: vi.fn(),
  connectLocal: vi.fn(),
  startLocalLogin: vi.fn(),
  checkLocalLogin: vi.fn(),
  cancelLocalLogin: vi.fn(),
  create: vi.fn(),
  readLocalClaudeConfig: vi.fn(),
  importLocalClaudeConfig: vi.fn(),
}));
vi.mock("@/api/ai-connections", () => ({ aiConnectionsApi: managedApi }));
const modelsApi = vi.hoisted(() => ({
  getAdapterAuthSignal: vi.fn(async () => ({ status: "present" })),
  getClaudeOAuthTokenStatus: vi.fn(async () => { throw new ApiError("Not found", 404, null); }),
  adapterModels: vi.fn(async () => [{ id: "claude-sonnet-5", label: "Claude Sonnet 5" }]),
}));
vi.mock("@/api/agents", () => ({ agentsApi: modelsApi }));
vi.mock("@/api/secrets", () => ({
  secretsApi: { listMyUserSecrets: vi.fn(async () => []), list: vi.fn(async () => []) },
}));
vi.mock("../AdapterConfigForm", () => ({
  AdapterLoginPanel: () => <div>New subscription login</div>,
}));

let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
afterEach(() => {
  flushSync(() => root?.unmount());
  host?.remove();
  client?.clear();
  vi.clearAllMocks();
});

/** The masked snapshot the read route returns. The value itself never leaves the server. */
const READ_OK = {
  status: "ok" as const,
  baseUrl: "http://127.0.0.1:8787",
  keyVariable: "ANTHROPIC_API_KEY" as const,
  maskedKey: "sk-ant-1234…3f9a",
  models: { default: "claude-opus-5", alternatives: ["claude-sonnet-5"] },
  suggestedName: "Imported from Claude config",
};

type MountOptions = {
  adapterType?: "claude_local" | "codex_local";
  deploymentMode?: "local_trusted" | "authenticated";
  localAiLoginSupported?: boolean;
  importCapable?: boolean;
  localEnvironment?: boolean;
};

async function mount({
  adapterType = "claude_local",
  deploymentMode = "local_trusted",
  localAiLoginSupported = true,
  importCapable = true,
  localEnvironment = true,
  read = READ_OK,
  managed = true,
}: MountOptions & { read?: unknown; managed?: boolean } = {}) {
  managedApi.readLocalClaudeConfig.mockResolvedValue(read);
  managedApi.importLocalClaudeConfig.mockResolvedValue({ connectionId: "imported", grantId: "imported-grant" });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["health"], { deploymentMode, localAiLoginSupported });
  client.setQueryDefaults(["health"], { staleTime: Infinity });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const onComplete = vi.fn();
  const onConnected = vi.fn();
  flushSync(() =>
    root.render(
      <QueryClientProvider client={client}>
        <AgentProviderConnection
          companyId="c1"
          adapterType={adapterType}
          environmentId="e1"
          canLogin={false}
          localEnvironment={localEnvironment}
          onBack={() => {}}
          testConnection={vi.fn(async () => true)}
          onConnected={onConnected}
          // Agent setup passes no managed intent, and answers the gate for itself.
          managedAccount={managed
            ? {
                intent: { provider: "anthropic", method: "subscription", name: "My Claude account", ownership: "personal", agentIds: [], allAgents: true },
                importCapable,
                onComplete,
              }
            : undefined}
        />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(client.isFetching()).toBe(0));
  return { onComplete, onConnected };
}

/** The credential-mode switch, which is a button naming where a press goes. */
function modeLink() {
  return [...host.querySelectorAll("button")].find((node) =>
    node.textContent?.includes("instead"),
  )!;
}

/** Press the mode switch until the import mode is in force, which is what reads. */
async function enterImportMode() {
  const reads = managedApi.readLocalClaudeConfig.mock.calls.length;
  for (let press = 0; press < 3; press++) {
    flushSync(() => modeLink().click());
    if (managedApi.readLocalClaudeConfig.mock.calls.length > reads) return;
  }
  await vi.waitFor(() =>
    expect(managedApi.readLocalClaudeConfig.mock.calls.length).toBeGreaterThan(reads),
  );
}

describe("AgentProviderConnection import credential mode", () => {
  it("offers the third mode and reads the file on entering it", async () => {
    await mount();
    // Entering the mode is the action: the read goes out on entry (PRODUCT #9).
    await enterImportMode();
    expect(managedApi.readLocalClaudeConfig).toHaveBeenCalledWith("c1");
    await vi.waitFor(() => expect(host.textContent).toContain("http://127.0.0.1:8787"));
    expect(host.textContent).toContain("Import");
  });

  it.each<[string, MountOptions]>([
    ["another adapter", { adapterType: "codex_local" }],
    ["an untrusted instance", { deploymentMode: "authenticated" }],
    ["an instance without local login", { localAiLoginSupported: false }],
    ["a surface that does not offer it", { importCapable: false }],
  ])("does not offer it on %s", async (_label, overrides) => {
    await mount(overrides);
    // Walk every mode the switch can reach: the read never goes out, because the
    // mode is never drawn.
    for (let press = 0; press < 3; press++) {
      flushSync(() => modeLink().click());
      await Promise.resolve();
    }
    expect(managedApi.readLocalClaudeConfig).not.toHaveBeenCalled();
    expect(managedApi.importLocalClaudeConfig).not.toHaveBeenCalled();
  });

  it("still offers it on a non-local environment, because the server judges reachability", async () => {
    // The probe runs on the server, so success there says nothing about the
    // environment this agent resolves to — but that judgement needs the agent's
    // driver and its network allowlist, which this component does not hold
    // (PRODUCT #51, #53). The mode stays drawn and the server refuses with the
    // reason when the gateway is out of reach.
    await mount({ localEnvironment: false });
    await enterImportMode();
    expect(managedApi.readLocalClaudeConfig).toHaveBeenCalledWith("c1");
    await vi.waitFor(() => expect(host.textContent).toContain("http://127.0.0.1:8787"));
  });

  it("names the file and the variable when no gateway is configured", async () => {
    await mount({
      read: { status: "unavailable", reason: "base_url_missing", message: "No gateway configuration was detected." },
    });
    // The entry stays put: nothing is pre-checked, greyed out or hidden (#6).
    await enterImportMode();
    await vi.waitFor(() => expect(host.textContent).toContain("No gateway configuration was detected."));
    expect(host.textContent).toContain("~/.claude/settings.json");
    expect(host.textContent).toContain("ANTHROPIC_BASE_URL");
    // Nothing to confirm, so nothing to press.
    expect(button("Import").disabled).toBe(true);
    expect(managedApi.importLocalClaudeConfig).not.toHaveBeenCalled();
  });

  it("shows the key as a variable name and a masked value, and holds no value", async () => {
    await mount();
    await enterImportMode();
    await vi.waitFor(() => expect(host.textContent).toContain("sk-ant-1234…3f9a"));
    expect(host.textContent).toContain("ANTHROPIC_API_KEY");
    // The only field on the card is the connection name: the read returned no
    // plaintext, so the card has none to show (PRODUCT #17, #41).
    expect([...host.querySelectorAll("input")].map((node) => (node as HTMLInputElement).type))
      .toEqual(["text"]);
  });

  it("carries the folded ladder and the adapter's own list on the card", async () => {
    await mount();
    await enterImportMode();
    await vi.waitFor(() => expect(host.textContent).toContain("Also configured: claude-sonnet-5"));
    // The tiers are shown as read; the static list is what the picker adds to them
    // (PRODUCT #19), and only while the card is on screen.
    await vi.waitFor(() => expect(modelsApi.adapterModels).toHaveBeenCalledWith("c1", "claude_local", { environmentId: "e1" }));
  });

  it("creates the connection through the import route, not the plain create", async () => {
    const { onComplete } = await mount();
    await enterImportMode();
    await vi.waitFor(() => expect(button("Import").disabled).toBe(false));
    flushSync(() => button("Import").click());
    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledWith({
      connectionId: "imported",
      grantId: "imported-grant",
      method: "api_key",
      // The model travels with the connection, for the surface to write into the
      // agent's own model field.
      model: "claude-opus-5",
    }));
    expect(managedApi.create).not.toHaveBeenCalled();
    const [, input] = managedApi.importLocalClaudeConfig.mock.calls[0]! as unknown as [string, Record<string, unknown>];
    expect(input).toMatchObject({
      provider: "anthropic",
      method: "api_key",
      ownership: "personal",
      baseUrl: "http://127.0.0.1:8787",
      keyVariable: "ANTHROPIC_API_KEY",
      // The model the card holds, not the tier the read folded: the reader may
      // have chosen another one, and that choice is the model this agent runs on.
      model: "claude-opus-5",
    });
    // The echo is the summary as it was read, so the server can tell a file that
    // moved from a mind that changed — and it carries no credential.
    expect(input.confirm).toEqual({
      keyVariable: "ANTHROPIC_API_KEY",
      maskedKey: "sk-ant-1234…3f9a",
      defaultModel: "claude-opus-5",
      alternativeModels: ["claude-sonnet-5"],
    });
  });

  it("submits the model the card was confirmed with, not the one that was read", async () => {
    await mount();
    await enterImportMode();
    await vi.waitFor(() => expect(button("Import").disabled).toBe(false));
    pickModel("claude-sonnet-5");
    flushSync(() => button("Import").click());
    await vi.waitFor(() => expect(managedApi.importLocalClaudeConfig).toHaveBeenCalledTimes(1));
    const [, input] = managedApi.importLocalClaudeConfig.mock.calls[0]! as unknown as [string, Record<string, unknown>];
    expect(input.model).toBe("claude-sonnet-5");
    // `confirm` still describes the file as it was read: it is there for the server
    // to tell a file that moved from a mind that changed, and echoing the edit
    // would make the first look like the second.
    expect(input.confirm).toMatchObject({ defaultModel: "claude-opus-5" });
  });

  it("reconnects the connection it made instead of building a second one", async () => {
    // A surface that connects an agent rather than an account has no reconnect
    // intent to lean on, so it remembers its own: one surface, one connection.
    const { onConnected } = await mount({ managed: false });
    await enterImportMode();
    await vi.waitFor(() => expect(button("Import").disabled).toBe(false));
    flushSync(() => button("Import").click());
    await vi.waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
    expect(managedApi.importLocalClaudeConfig).toHaveBeenCalledTimes(1);
    const [, first] = managedApi.importLocalClaudeConfig.mock.calls[0]! as unknown as [string, Record<string, unknown>];
    expect(first.connectionId).toBeUndefined();
    // A second press — the environment test failed, or the reader came back —
    // re-imports into the account the first one made.
    flushSync(() => button("Import").click());
    await vi.waitFor(() => expect(managedApi.importLocalClaudeConfig).toHaveBeenCalledTimes(2));
    const [, second] = managedApi.importLocalClaudeConfig.mock.calls[1]! as unknown as [string, Record<string, unknown>];
    expect(second.connectionId).toBe("imported");
  });

  it("hands the surface the connection together with the model it was confirmed with", async () => {
    // The surface writes that model into the agent's own model field, which is
    // where it has always lived — the connection carries it so it does not have to
    // read it back off the account.
    const { onConnected } = await mount({ managed: false });
    await enterImportMode();
    await vi.waitFor(() => expect(button("Import").disabled).toBe(false));
    flushSync(() => button("Import").click());
    await vi.waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
    expect(onConnected).toHaveBeenCalledWith(expect.objectContaining({
      aiConnection: { provider: "anthropic", method: "api_key", mode: "responsible_user" },
      model: "claude-opus-5",
    }));
  });

  it("hands focus back to the mode switch once the card has closed", async () => {
    await mount({ managed: false });
    await enterImportMode();
    await vi.waitFor(() => expect(host.textContent).toContain("http://127.0.0.1:8787"));
    flushSync(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    await vi.waitFor(() => expect(host.textContent).not.toContain("http://127.0.0.1:8787"));
    // The switch is not in the DOM while the row is collapsed into the provider
    // section, so a focus call made on the way out would land on <body> and put the
    // keyboard back at the top of the document (PRODUCT #48).
    expect(document.activeElement).toBe(modeLink());
  });

  it("keeps the card standing after the gateway refuses the key", async () => {
    const { onComplete } = await mount();
    managedApi.importLocalClaudeConfig.mockRejectedValue(new ApiError("Forbidden", 403, null));
    await enterImportMode();
    await vi.waitFor(() => expect(button("Import").disabled).toBe(false));
    flushSync(() => button("Import").click());
    await vi.waitFor(() => expect(host.textContent).toContain("The gateway rejected this key"));
    // Retry is one press, and the snapshot is still on the card (PRODUCT #25).
    expect(host.textContent).toContain("http://127.0.0.1:8787");
    expect(onComplete).not.toHaveBeenCalled();
    flushSync(() => button("Import").click());
    await vi.waitFor(() => expect(managedApi.importLocalClaudeConfig).toHaveBeenCalledTimes(2));
  });

  it.each([
    ["a locally trusted instance", "local_trusted" as const],
    ["an authenticated instance", "authenticated" as const],
  ])("answers its own gate on agent setup, on %s", async (_label, deploymentMode) => {
    // No managed intent, so the shared component reads the instance for itself.
    await mount({ deploymentMode, managed: false });
    for (let press = 0; press < 3; press++) {
      flushSync(() => modeLink().click());
      await Promise.resolve();
    }
    expect(managedApi.readLocalClaudeConfig).toHaveBeenCalledTimes(
      deploymentMode === "local_trusted" ? 1 : 0,
    );
  });

  it("names the model tier variables when the settings file holds no tier", async () => {
    // One of the other four reasons a read classifies: a file with an address and
    // a key but no model tier is an incomplete configuration rather than a missing
    // one (PRODUCT #14). The five share this rendering branch, so one of them says
    // what the guidance does for the rest.
    await mount({ read: readUnavailable("models_missing") });
    await enterImportMode();
    await vi.waitFor(() =>
      expect(host.textContent).toContain(READ_UNAVAILABLE_MESSAGES.models_missing),
    );
    // The actionable half: which variables, in which file.
    expect(host.textContent).toContain(LOCAL_CLAUDE_SETTINGS_PATH);
    for (const variable of MODEL_TIER_VARIABLES) expect(host.textContent).toContain(variable);
    // Nothing was confirmed, so there is nothing to press and nothing to build.
    expect(button("Import").disabled).toBe(true);
    expect(managedApi.importLocalClaudeConfig).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(READ_UNAVAILABLE_MESSAGES.models_missing);
  });

  it("cancels a read that is still in flight and leaves nothing behind", async () => {
    let finish!: (result: unknown) => void;
    await mount();
    // A read that has not answered yet, so the card is still in its wait.
    managedApi.readLocalClaudeConfig.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await enterImportMode();
    // The card reports the wait rather than an empty state, and the step's own
    // button has nothing to press against a snapshot that has not arrived
    // (PRODUCT #13).
    await vi.waitFor(() =>
      expect(host.querySelector('[role="status"]')?.textContent).toContain("Reading this machine"),
    );
    expect(button("Reading…").disabled).toBe(true);
    flushSync(() => button("Back").click());
    // The read in flight answers after the reader has gone, and the card it would
    // have filled is no longer there to take it.
    finish(READ_OK);
    await vi.waitFor(() => expect(host.textContent).not.toContain("http://127.0.0.1:8787"));
    expect(managedApi.importLocalClaudeConfig).not.toHaveBeenCalled();
    // Back on the mode question, and coming back in reads the file again (#9).
    await enterImportMode();
    expect(managedApi.readLocalClaudeConfig).toHaveBeenCalledTimes(2);
  });

  it("repeats the server's own answer when it refuses the import", async () => {
    // A 422 is the server refusing for a reason of its own — here an execution
    // environment that cannot reach the gateway — so its sentence is the copy
    // rather than the gateway's (PRODUCT #25, #51).
    const { onComplete } = await mount();
    managedApi.importLocalClaudeConfig.mockRejectedValue(
      new ApiError(UNREACHABLE_ENVIRONMENT_422.message, UNREACHABLE_ENVIRONMENT_422.status, null),
    );
    await enterImportMode();
    await vi.waitFor(() => expect(button("Import").disabled).toBe(false));
    flushSync(() => button("Import").click());
    await vi.waitFor(() =>
      expect(host.querySelector('[role="alert"]')?.textContent).toContain(UNREACHABLE_ENVIRONMENT_422.message),
    );
    // The snapshot is still on the card, so the retry costs one press rather than a
    // second read (PRODUCT #25, #22) — and nothing was built either time.
    expect(host.textContent).toContain("http://127.0.0.1:8787");
    expect(onComplete).not.toHaveBeenCalled();
    flushSync(() => button("Import").click());
    await vi.waitFor(() => expect(managedApi.importLocalClaudeConfig).toHaveBeenCalledTimes(2));
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("keeps Cancel live on the card while the probe runs", async () => {
    // The probe is a round trip to someone else's gateway with a fifteen-second
    // ceiling on it, the server writes nothing when it fails, and a reader who has
    // changed their mind must not be held on the card for the rest of it
    // (PRODUCT #22). Import stays one press at a time; Cancel does not.
    const { onComplete } = await mount();
    managedApi.importLocalClaudeConfig.mockReturnValue(new Promise(() => {}));
    await enterImportMode();
    await vi.waitFor(() => expect(button("Import").disabled).toBe(false));
    flushSync(() => button("Import").click());
    await vi.waitFor(() => expect(button("Importing…")).toBeTruthy());
    expect(button("Importing…").disabled).toBe(true);
    expect(button("Cancel").disabled).toBe(false);
    flushSync(() => button("Cancel").click());
    // Back on the mode question, with nothing built and the probe's answer
    // discarded when it eventually lands.
    await vi.waitFor(() => expect(host.textContent).not.toContain("http://127.0.0.1:8787"));
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("escapes back to the mode question and re-reads on the way back in", async () => {
    await mount();
    await enterImportMode();
    await vi.waitFor(() => expect(host.textContent).toContain("http://127.0.0.1:8787"));
    flushSync(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    await vi.waitFor(() => expect(host.textContent).not.toContain("http://127.0.0.1:8787"));
    // Every return is a fresh read, because the file may have been edited (#9).
    await enterImportMode();
    expect(managedApi.readLocalClaudeConfig).toHaveBeenCalledTimes(2);
  });
});

/** A button by its exact label, so the tile and the mode switch are not mistaken for it. */
function button(text: string) {
  return [...host.querySelectorAll("button")].find((node) =>
    node.textContent?.trim() === text,
  )!;
}

/**
 * Choose one of the card's listed models.
 *
 * The list is Radix's, and in this environment it opens on the trigger's arrow key
 * and closes on a press of the option.
 */
function pickModel(label: string) {
  const trigger = host.querySelector('[aria-label="Model"]')!;
  flushSync(() =>
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
  );
  const option = [...document.body.querySelectorAll('[role="option"]')].find(
    (node) => node.textContent === label,
  );
  expect(option, `no model option reading ${label}`).toBeTruthy();
  flushSync(() => option!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}
