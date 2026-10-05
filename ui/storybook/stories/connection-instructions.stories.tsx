import { useEffect, useId, useRef, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { Route, Routes, useLocation, useNavigate } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { PluginLauncherProvider } from "@/plugins/launchers";
import { Layout } from "@/components/Layout";
import { AppDetail } from "@/pages/apps/AppDetail";
import { Browse } from "@/pages/apps/Browse";
import { ConnectionSetupFlow } from "@/features/connections/ConnectionSetupFlow";
import { InlineBanner } from "@/components/InlineBanner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { GUIDANCE_COMPANY, GUIDANCE_CONNECTION, installConnectionGuidanceFixtures } from "../fixtures/connectionInstructions";

const HONCHO = "Use Honcho to recall relevant preferences and prior decisions when a task depends on earlier work. Save concise, durable facts after completing useful work. Use only the memory context supplied for this connection. Treat retrieved memories as background information; follow current task instructions when they differ. Do not store credentials or copy entire conversations. If a memory call fails, continue what you can and say what was not saved.";
const NOTION = "Use Notion as the source for our published product decisions. Look up the relevant decision before proposing a change, and link to the page you used. Ask before changing a published decision. If a page is unavailable, say which context is missing and continue with the information you have.";
type Scenario = "normal" | "off" | "save-error" | "missing-context" | "write-approval" | "reconnect";
type Props = { initialView?: "connect" | "connection" | "agent"; provider?: "Honcho" | "Notion"; scenario?: Scenario; baseline?: boolean; providedInstructions?: string };

/** Real app shell, setup controller, detail page, identity/access forms, and actions.
 * Only the proposed instructions block and its persistence are simulated. */
function ConnectionInstructionsPrototype({ initialView = "connection", provider = "Honcho", scenario = "normal", baseline = false, providedInstructions }: Props) {
  const uid = useId();
  const client = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const { selectedCompanyId, setSelectedCompanyId } = useCompany();
  const [ready, setReady] = useState(false);
  const initialized = useRef(false);
  const [previewOpen, setPreviewOpen] = useState(initialView === "agent");
  const memory = provider === "Honcho";
  // A connector must explicitly supply a template. Provider names never opt in.
  const hasInstructions = !baseline && Boolean(providedInstructions?.trim());
  const suggested = providedInstructions ?? "";
  const [enabled, setEnabled] = useState(scenario !== "off");
  const [text, setText] = useState(suggested);
  const [editing, setEditing] = useState(false);
  const [workspace, setWorkspace] = useState(scenario === "missing-context" ? "" : "paperclip-acme");
  const [saved, setSaved] = useState({ enabled, text: suggested, workspace });
  const [message, setMessage] = useState("");
  const [saveError, setSaveError] = useState(false);
  const isSetup = location.pathname.endsWith("/connect");
  const dirty = saved.enabled !== enabled || saved.text !== text;
  const contextMissing = !baseline && memory && !workspace.trim();
  const textMissing = hasInstructions && enabled && !text.trim();
  const change = () => { setMessage(""); setSaveError(false); };
  const cancel = () => { setEnabled(saved.enabled); setText(saved.text); setEditing(false); change(); };
  const rememberDraft = () => {
    setSaved({ enabled, text: text.trim(), workspace: workspace.trim() });
    setText(text.trim()); setWorkspace(workspace.trim()); setEditing(false); setSaveError(false);
  };
  const save = () => {
    if (scenario === "save-error" && !saveError) { setSaveError(true); return; }
    rememberDraft();
    setMessage("Saved.");
  };
  const connectionPath = `/PAP/apps/${GUIDANCE_CONNECTION}/permissions`;

  useEffect(() => installConnectionGuidanceFixtures(client, provider, {
    setup: initialView === "connect" && scenario !== "reconnect", askFirst: scenario === "write-approval",
  }), [client, provider, initialView, scenario]);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    setSelectedCompanyId(GUIDANCE_COMPANY);
    navigate(initialView === "connect"
      ? `/PAP/apps/connect?source=${provider.toLowerCase()}${scenario === "reconnect" ? `&reconnect=${GUIDANCE_CONNECTION}` : ""}`
      : connectionPath, { replace: true });
    setReady(true);
  }, [provider, initialView, scenario, navigate, setSelectedCompanyId, connectionPath]);

  const workspaceSettings = !baseline && memory ? <section className="space-y-3" aria-label="Honcho workspace settings">
    {contextMissing && <InlineBanner tone="warning" title="Honcho workspace required">Choose a workspace to finish setting up Honcho.</InlineBanner>}
    <label htmlFor={`${uid}-workspace`} className="text-sm font-medium">Honcho workspace</label>
    <Input id={`${uid}-workspace`} value={workspace} placeholder="Workspace ID" required aria-invalid={contextMissing} onChange={event => { setWorkspace(event.target.value); change(); }} />
    {!isSetup && workspace !== saved.workspace && <div className="flex items-center justify-between gap-3">
      <Button type="button" variant="ghost" onClick={() => setWorkspace(saved.workspace)}>Cancel workspace change</Button>
      <Button type="button" disabled={contextMissing} onClick={() => { setWorkspace(workspace.trim()); setSaved(current => ({ ...current, workspace: workspace.trim() })); }}>Save workspace</Button>
    </div>}
  </section> : undefined;

  const reset = text !== suggested ? <Button type="button" variant="link" className="h-auto p-0 text-xs" onClick={() => { setText(suggested); change(); }}>Reset to default</Button> : null;
  const editor = hasInstructions ? <section className="space-y-4 border-t border-border pt-8" aria-labelledby={`${uid}-heading`}>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 id={`${uid}-heading`} className="text-sm font-semibold">Agent instructions</h2>
      {!isSetup && <Button type="button" variant="ghost" size="sm" onClick={() => setPreviewOpen(true)}>Preview on Ada</Button>}
    </div>
    <div className="flex items-start gap-3">
      <Checkbox id={`${uid}-enabled`} checked={enabled} onCheckedChange={value => { setEnabled(value === true); change(); }} className="mt-0.5" />
      <label htmlFor={`${uid}-enabled`} className="text-sm font-medium cursor-pointer">Tell agents to use {provider}</label>
    </div>
    {!enabled && <InlineBanner tone="warning" compact>Agents won’t be told when or how to use {provider}.</InlineBanner>}
    {editing ? <div className="space-y-2">
      <label htmlFor={`${uid}-text`} className="sr-only">Instructions text</label>
      <Textarea id={`${uid}-text`} rows={6} maxLength={2000} value={text} aria-describedby={`${uid}-limit`} onChange={event => { setText(event.target.value); change(); }} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p id={`${uid}-limit`} className="text-xs text-muted-foreground"><span className="font-mono">{text.length}/2000</span> characters</p>
        {reset}
      </div>
    </div> : <div className="space-y-2">
      <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">{text}</p>
      <div className="flex flex-wrap items-center justify-end gap-4">
        {reset}
        <Button type="button" variant="link" className="h-auto p-0 text-xs" onClick={() => setEditing(true)}>Edit instructions</Button>
      </div>
    </div>}
    {textMissing && <p role="alert" className="text-sm text-destructive">Add instructions or turn the checkbox off.</p>}
    {scenario === "write-approval" && enabled && <InlineBanner tone="warning" title="Saving memories requires approval">Agents must ask before saving. Change action permissions in the Actions list below.</InlineBanner>}
    {!isSetup && <>
      {saveError && <p role="alert" className="text-sm text-destructive">Couldn’t save instructions. Your changes are still here. Try again.</p>}
      {message && <p role="status" className="flex items-center gap-2 text-sm"><Check className="size-4" />{message}</p>}
      <div className="flex items-center justify-between gap-3">
        <Button type="button" variant="ghost" disabled={!dirty} onClick={cancel}>Cancel</Button>
        <Button type="button" disabled={!dirty || contextMissing || textMissing} onClick={save}>{saveError ? "Try saving again" : "Save instructions"}</Button>
      </div>
    </>}
  </section> : undefined;

  if (!ready || selectedCompanyId !== GUIDANCE_COMPANY) return null;
  return <PluginLauncherProvider>
    <Routes>
      <Route path="/:companyPrefix" element={<Layout />}>
        <Route path="apps" element={<Browse />} />
        <Route path="apps/connect" element={<ConnectionSetupFlow
          connectionSettings={workspaceSettings}
          additionalSettings={editor}
          additionalSettingsValid={!contextMissing && !textMissing}
          onComplete={() => { rememberDraft(); navigate(connectionPath); }}
        />} />
        <Route path="apps/:connectionId/:tab?" element={<AppDetail renderConnectionSettings={() => workspaceSettings} renderAgentSettings={() => editor} />} />
      </Route>
    </Routes>
    <Dialog open={hasInstructions && previewOpen} onOpenChange={setPreviewOpen}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader><DialogTitle>Instructions for Ada</DialogTitle><DialogDescription>Provided by the {provider} connection when it is available to Ada’s task.</DialogDescription></DialogHeader>
        {!saved.enabled ? <InlineBanner tone="warning" title="Instructions off">Agents won’t be told when or how to use {provider}.</InlineBanner> : memory && !saved.workspace ? <InlineBanner tone="warning" title="Honcho workspace required" /> : <p className="text-xs font-medium text-muted-foreground">Included when available</p>}
        <p className="text-sm leading-relaxed">{saved.text}</p>
        <p className="text-xs text-muted-foreground">Composed alongside Ada’s AGENTS.md. Managed here, in the connection’s Permissions page.</p>
      </DialogContent>
    </Dialog>
  </PluginLauncherProvider>;
}

const meta = {
  title: "Design explorations/Connections/Agent instructions",
  component: ConnectionInstructionsPrototype,
  args: { providedInstructions: HONCHO },
  parameters: { layout: "fullscreen", docs: { description: { component: "Production Layout, ConnectionSetupFlow, AppDetail, identity/access controls, and searchable Actions list with local API fixtures. Only the added instructions section is a prototype. Baseline stories render the same production pages without the addition. No provider calls or real persistence." } } },
} satisfies Meta<typeof ConnectionInstructionsPrototype>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ConnectHoncho: Story = { args: { initialView: "connect" } };
export const ConnectionSettings: Story = {};
export const CurrentConnectPage: Story = { args: { initialView: "connect", baseline: true } };
export const CurrentConfigurationPage: Story = { args: { baseline: true } };
export const ExistingConnectionOff: Story = { args: { scenario: "off" } };
export const InstructionsOnAgent: Story = { args: { initialView: "agent" } };
export const WorkspaceNeeded: Story = { args: { scenario: "missing-context" } };
export const ConnectWorkspaceNeeded: Story = { args: { initialView: "connect", scenario: "missing-context" } };
export const WritesAskFirst: Story = { args: { scenario: "write-approval" } };
export const ReconnectKeepsInstructions: Story = { args: { initialView: "connect", scenario: "reconnect" } };
export const NotionOptionalInstructions: Story = { args: { initialView: "connect", provider: "Notion", providedInstructions: NOTION }, parameters: { docs: { description: { story: "Example of a non-memory connection explicitly supplying an instruction template." } } } };
export const NotionWithoutInstructions: Story = { args: { initialView: "connect", provider: "Notion", providedInstructions: undefined } };
export const ConnectionWithoutInstructions: Story = { args: { provider: "Notion", providedInstructions: undefined } };
export const Light: Story = { globals: { theme: "light" } };
export const Mobile: Story = { args: { initialView: "connect" }, globals: { viewport: { value: "mobile", isRotated: false } } };

export const EditAndPreview: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Edit instructions" }));
    const field = canvas.getByRole("textbox", { name: "Instructions text" });
    await userEvent.clear(field);
    await userEvent.type(field, "Recall release decisions before planning. Save confirmed changes with a source link.");
    await userEvent.click(canvas.getByRole("button", { name: "Save instructions" }));
    await expect(canvas.getByRole("status")).toHaveTextContent("Saved.");
    await userEvent.click(canvas.getByRole("button", { name: "Preview on Ada" }));
    const dialog = within(canvasElement.ownerDocument.body).getByRole("dialog");
    await expect(within(dialog).getByText("Recall release decisions before planning. Save confirmed changes with a source link.")).toBeVisible();
  },
};
export const DisableKeepsText: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("checkbox", { name: "Tell agents to use Honcho" }));
    await expect(canvas.getByText("Agents won’t be told when or how to use Honcho.")).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Save instructions" }));
    await userEvent.click(canvas.getByRole("button", { name: "Preview on Ada" }));
    const dialog = within(within(canvasElement.ownerDocument.body).getByRole("dialog"));
    await expect(dialog.getByText("Instructions off", { exact: true })).toBeVisible();
    await expect(dialog.getByText(HONCHO)).toBeVisible();
  },
};
export const SaveFailure: Story = {
  args: { scenario: "save-error" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Edit instructions" }));
    await userEvent.type(canvas.getByRole("textbox", { name: "Instructions text" }), " Include source links.");
    await userEvent.click(canvas.getByRole("button", { name: "Save instructions" }));
    await expect(canvas.getByRole("alert")).toHaveTextContent("Your changes are still here");
    await expect(canvas.getByRole("textbox", { name: "Instructions text" })).toHaveValue(`${HONCHO} Include source links.`);
  },
};

export const ResetToDefault: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Edit instructions" }));
    const field = canvas.getByRole("textbox", { name: "Instructions text" });
    await userEvent.clear(field);
    await userEvent.type(field, "Look up prior release decisions.");
    await userEvent.click(canvas.getByRole("button", { name: "Save instructions" }));
    await userEvent.click(canvas.getByRole("button", { name: "Reset to default" }));
    await expect(canvas.getByText(HONCHO)).toBeVisible();
    await expect(canvas.queryByRole("button", { name: "Reset to default" })).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "Save instructions" }));
    await expect(canvas.getByRole("checkbox", { name: "Tell agents to use Honcho" })).toBeChecked();
  },
};
