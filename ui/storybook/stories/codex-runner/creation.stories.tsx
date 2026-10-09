import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within, waitFor } from "storybook/test";
import { NewAgent } from "@/pages/NewAgent";
import { AgentBasicsDialog } from "@/components/new-agent/AgentBasicsDialog";
import { models } from "@paperclipai/adapter-codex-local";
import { storybookHiredAgent } from "../../fixtures/paperclipData";
import { resetOnboardingFixtureState, setOnboardingFixtureState } from "../../fixtures/onboardingEnvironment";

/** Real creation screen; existing Storybook API fixtures provide isolated accounts. */
function installCodexCreationFixture({ setupFailure = false, nativeRunnerEnabled = false, unqualifiedTarget = false }: { setupFailure?: boolean; nativeRunnerEnabled?: boolean; unqualifiedTarget?: boolean } = {}) {
  resetOnboardingFixtureState();
  setOnboardingFixtureState({ environments: "local", authSignal: "present", localLoginStatus: "ready", savedManagedSubscription: "openai" });
  const previous = window.fetch;
  let created = storybookHiredAgent;
  const fixtureFetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin);
    const body = () => JSON.parse(typeof init?.body === "string" ? init.body : "{}");
    if (url.pathname === "/api/instance/settings/experimental") {
      const response = await previous(input, init);
      return Response.json({ ...await response.json(), enableNativeRunner: nativeRunnerEnabled });
    }
    if (url.pathname === "/api/instance/settings/general") return Response.json({ executionMode: "any" });
    if (url.pathname === "/api/health") {
      const response = await previous(input, init);
      return Response.json({ ...await response.json(), status: "ok" });
    }
    if (url.pathname === "/api/adapters") {
      const response = await previous(input, init);
      const adapters = (await response.json()).map((adapter: { type: string }) => adapter.type === "codex_local" ? { ...adapter, supportedRunners: unqualifiedTarget ? ["legacy"] : ["paperclip", "legacy"], defaultRunner: unqualifiedTarget ? "legacy" : "paperclip" } : adapter);
      return Response.json(nativeRunnerEnabled || unqualifiedTarget ? [...adapters, { type: "paperclip_runner", label: "Paperclip Runner", source: "builtin", loaded: true, disabled: false, modelsCount: 0 }] : adapters);
    }
    if (url.pathname.endsWith("/adapters/codex_local/models")) return Response.json(models);
    if (url.pathname.endsWith("/adapters/codex_local/test-environment")) {
      const request = body();
      const native = request.runner !== "legacy";
      return Response.json({ adapterType: native ? "paperclip_runner" : "codex_local", testedAt: new Date(0).toISOString(), status: setupFailure && native ? "fail" : "pass",
        checks: setupFailure && native ? [{ code: "runner_missing", level: "error", message: "Paperclip Runner is missing from this environment.", hint: "Install the runner or choose Legacy runner in Advanced." }]
          : [{ code: native ? "paperclip_runner_codex_hello_probe_passed" : "codex_hello_probe_passed", level: "info", message: "The selected runtime responded." }],
      });
    }
    if (url.pathname.endsWith("/agent-hires")) {
      const request = body();
      const native = request.runner !== "legacy";
      created = { ...storybookHiredAgent, ...request, adapterType: native ? "paperclip_runner" : "codex_local", adapterConfig: { ...request.adapterConfig, ...(native ? { provider: "codex" } : {}) } };
      return Response.json({ agent: created, approval: null });
    }
    if (url.pathname === `/api/agents/${created.id}`) return Response.json(created);
    return previous(input, init);
  };
  window.fetch = fixtureFetch;
  return () => { if (window.fetch === fixtureFetch) window.fetch = previous; resetOnboardingFixtureState(); };
}

const meta = {
  title: "Agents/Codex runner/Creation",
  component: NewAgent,
  parameters: { layout: "fullscreen", initialEntries: ["/PAP/agents/new?name=Nova&adapterType=codex_local"], docs: { description: { component: "Production NewAgent page and shared pickers. Accounts and API replies use isolated Storybook fixtures; these stories establish UI behavior, not live execution qualification. The native default works with the old experimental gate off." } } },
  beforeEach: ({ parameters }) => installCodexCreationFixture(parameters.codexCreationFixture),
  render: () => <NewAgent />,
} satisfies Meta<typeof NewAgent>;
export default meta;
type Story = StoryObj<typeof meta>;
const showRunner: NonNullable<Story["play"]> = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByText("Advanced", { exact: true, selector: "summary" }));
  await expect(await canvas.findByRole("button", { name: "Runner" })).toBeVisible();
};
const connectCodex: NonNullable<Story["play"]> = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole("radio", { name: /OpenAI.*Subscription/ }));
  const connect = await canvas.findByRole("button", { name: /^(Connect|Use saved subscription)$/ });
  await waitFor(() => expect(connect).toBeEnabled());
  await userEvent.click(connect);
};
export const AutomaticCodex: Story = { play: showRunner };
export const ExplicitLegacy: Story = { parameters: { initialEntries: ["/PAP/agents/new?name=Nova&adapterType=codex_local&runner=legacy"] }, play: showRunner };
export const OldNativeCodexLink: Story = {
  parameters: { initialEntries: ["/PAP/agents/new?name=Nova&adapterType=paperclip_runner&runnerProvider=codex"], codexCreationFixture: { unqualifiedTarget: true } },
  play: async context => {
    await showRunner(context);
    await expect(await within(context.canvasElement).findByRole("button", { name: "Runner" })).toHaveTextContent("Paperclip Runner");
  },
};
export const AutomaticLight: Story = { ...AutomaticCodex, globals: { theme: "light" } };
export const LegacyMobile: Story = { ...ExplicitLegacy, globals: { viewport: { value: "mobile1", isRotated: false } } };
export const SetupFailure: Story = { parameters: { codexCreationFixture: { setupFailure: true } }, play: async context => {
  await connectCodex(context);
  await expect(await within(context.canvasElement).findByText("Paperclip Runner is missing from this environment.")).toBeVisible();
  await showRunner(context);
} };
export const TaskReady: Story = {
  play: async context => {
    await connectCodex(context);
    const canvas = within(context.canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Finish setup" }));
    await expect(await canvas.findByRole("heading", { name: /is ready/ })).toBeVisible();
  },
};
export const ExperimentalNativeHarnesses: Story = {
  parameters: { codexCreationFixture: { nativeRunnerEnabled: true } },
  render: () => <AgentBasicsDialog open onClose={() => {}} onContinue={() => {}} />,
  play: async () => {
    const dialog = within(document.body);
    await userEvent.type(await dialog.findByRole("textbox", { name: "Agent name" }), "Nova");
    await userEvent.click(await dialog.findByRole("button", { name: "Choose adapter" }));
    await userEvent.click(await dialog.findByText("Advanced", { exact: true, selector: "summary" }));
    await userEvent.click(await dialog.findByRole("button", { name: "Experimental harness" }));
    await expect(await dialog.findByRole("option", { name: "Grok Build (Paperclip Runner)" })).toBeVisible();
    await expect(await dialog.findByRole("option", { name: "OpenCode (Paperclip Runner)" })).toBeVisible();
    await userEvent.click(await dialog.findByRole("option", { name: "Claude Code (Paperclip Runner)" }));
    await expect(await dialog.findByRole("button", { name: "Experimental harness" })).toHaveTextContent("Claude Code");
    await expect(await dialog.findByRole("button", { name: "Configure agent" })).toBeEnabled();
  },
};
