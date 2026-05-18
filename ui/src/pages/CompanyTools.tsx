import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CompanyToolCreate,
  CompanyToolRisk,
  CompanyToolSource,
  ToolAccessMode,
} from "@paperclipai/shared";
import { Plus, Save, Wrench } from "lucide-react";
import { agentsApi } from "@/api/agents";
import { toolAccessApi } from "@/api/tool-access";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

const modes: ToolAccessMode[] = ["off", "read", "write", "admin"];
const sources: CompanyToolSource[] = ["mcp_tool", "adapter_toolset", "paperclip_builtin", "skill"];
const risks: CompanyToolRisk[] = ["read", "write", "admin", "secret"];

type ToolForm = {
  key: string;
  label: string;
  source: CompanyToolSource;
  adapter: string;
  risk: CompanyToolRisk;
  serverKey: string;
  toolName: string;
  render: string;
};

const defaultToolForm: ToolForm = {
  key: "",
  label: "",
  source: "mcp_tool",
  adapter: "hermes_local",
  risk: "read",
  serverKey: "",
  toolName: "",
  render: "{\n  \"hermes\": {}\n}",
};

function formatMode(mode: ToolAccessMode) {
  return mode[0]!.toUpperCase() + mode.slice(1);
}

function formatToken(value: string) {
  return value.replaceAll("_", " ");
}

function toolSupportedModes(risk: CompanyToolRisk): ToolAccessMode[] {
  return risk === "read" ? ["off", "read"] : ["off", "read", "write", "admin"];
}

export function CompanyTools() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const companyId = selectedCompanyId ?? selectedCompany?.id ?? "";
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Record<string, ToolAccessMode>>({});
  const [toolForm, setToolForm] = useState<ToolForm>(defaultToolForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [selectedPresetAgentId, setSelectedPresetAgentId] = useState("");
  const [selectedPresetId, setSelectedPresetId] = useState("");
  const [grantNotice, setGrantNotice] = useState<string | null>(null);
  const [presetNotice, setPresetNotice] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Settings", href: "/company/settings" },
      { label: "Tools" },
    ]);
  }, [setBreadcrumbs, selectedCompany?.name]);

  const { data: agents = [] } = useQuery({
    queryKey: companyId ? queryKeys.agents.list(companyId) : ["agents", "__disabled__"] as const,
    queryFn: () => agentsApi.list(companyId),
    enabled: Boolean(companyId),
  });

  const { data: matrix, isLoading } = useQuery({
    queryKey: companyId ? queryKeys.toolAccess.matrix(companyId) : ["tool-access", "__disabled__"] as const,
    queryFn: () => toolAccessApi.matrix(companyId),
    enabled: Boolean(companyId),
  });

  const { data: presets = [] } = useQuery({
    queryKey: companyId ? queryKeys.toolAccess.presets(companyId) : ["tool-access", "__disabled__", "presets"] as const,
    queryFn: () => toolAccessApi.listPresets(companyId),
    enabled: Boolean(companyId),
  });

  const grantByCell = useMemo(() => {
    const map = new Map<string, ToolAccessMode>();
    for (const grant of matrix?.grants ?? []) {
      map.set(`${grant.agentId}:${grant.toolId}`, grant.mode);
    }
    return map;
  }, [matrix?.grants]);

  const saveGrants = useMutation({
    mutationFn: () => toolAccessApi.setGrants(
      companyId,
      Object.entries(draft).map(([cell, mode]) => {
        const [agentId, toolId] = cell.split(":");
        return { agentId: agentId!, toolId: toolId!, mode };
      }),
    ),
    onSuccess: async (result) => {
      setDraft({});
      setGrantNotice(
        result.approvals?.length
          ? `${result.approvals.length} change${result.approvals.length === 1 ? "" : "s"} awaiting approval.`
          : null,
      );
      await queryClient.invalidateQueries({ queryKey: queryKeys.toolAccess.matrix(companyId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
      if (result.approvals?.length) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(companyId) });
        await queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(companyId, "pending") });
      }
    },
  });

  const applyPreset = useMutation({
    mutationFn: () => toolAccessApi.applyPreset(companyId, {
      agentId: selectedPresetAgentId,
      presetId: selectedPresetId,
    }),
    onSuccess: async (result) => {
      setPresetNotice(
        result.approvals?.length
          ? `${result.approvals.length} preset change${result.approvals.length === 1 ? "" : "s"} awaiting approval.`
          : "Preset applied.",
      );
      await queryClient.invalidateQueries({ queryKey: queryKeys.toolAccess.matrix(companyId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(companyId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(companyId, "pending") });
    },
  });

  const createTool = useMutation({
    mutationFn: (payload: CompanyToolCreate) => toolAccessApi.createTool(companyId, payload),
    onSuccess: async () => {
      setToolForm(defaultToolForm);
      setFormError(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.toolAccess.matrix(companyId) });
    },
    onError: (error) => {
      setFormError(error instanceof Error ? error.message : "Failed to add tool");
    },
  });

  function updateForm<K extends keyof ToolForm>(key: K, value: ToolForm[K]) {
    setToolForm((prev) => ({ ...prev, [key]: value }));
  }

  function handleCreateTool() {
    if (!companyId) return;
    let render: Record<string, unknown>;
    try {
      const parsed = JSON.parse(toolForm.render);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("Render JSON must be an object.");
      }
      render = parsed as Record<string, unknown>;
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Render JSON is invalid.");
      return;
    }

    const payload: CompanyToolCreate = {
      key: toolForm.key.trim(),
      label: toolForm.label.trim(),
      source: toolForm.source,
      adapter: toolForm.adapter.trim(),
      risk: toolForm.risk,
      supportedModes: toolSupportedModes(toolForm.risk),
      render,
    };
    const serverKey = toolForm.serverKey.trim();
    const toolName = toolForm.toolName.trim();
    if (serverKey) payload.serverKey = serverKey;
    if (toolName) payload.toolName = toolName;

    setFormError(null);
    createTool.mutate(payload);
  }

  function setCellMode(agentId: string, toolId: string, mode: ToolAccessMode) {
    const cell = `${agentId}:${toolId}`;
    const current = grantByCell.get(cell) ?? "off";
    setDraft((prev) => {
      const next = { ...prev };
      if (mode === current) {
        delete next[cell];
      } else {
        next[cell] = mode;
      }
      return next;
    });
  }

  if (!selectedCompany) {
    return (
      <div className="text-sm text-muted-foreground">
        No company selected. Select a company from the switcher above.
      </div>
    );
  }

  const dirtyCount = Object.keys(draft).length;

  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex items-center gap-2">
        <Wrench className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">Tools</h1>
      </div>

      <section className="space-y-4">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Catalog
        </div>
        <div className="rounded-md border border-border px-4 py-4">
          <div className="grid gap-3 md:grid-cols-2">
            <label className="space-y-1 text-xs font-medium text-muted-foreground">
              Key
              <Input
                data-testid="company-tools-key"
                value={toolForm.key}
                onChange={(event) => updateForm("key", event.target.value)}
                placeholder="mcp.gbrain.query"
                className="mt-1"
              />
            </label>
            <label className="space-y-1 text-xs font-medium text-muted-foreground">
              Label
              <Input
                data-testid="company-tools-label"
                value={toolForm.label}
                onChange={(event) => updateForm("label", event.target.value)}
                placeholder="GBrain query"
                className="mt-1"
              />
            </label>
            <label className="space-y-1 text-xs font-medium text-muted-foreground">
              Source
              <select
                value={toolForm.source}
                onChange={(event) => updateForm("source", event.target.value as CompanyToolSource)}
                className="mt-1 h-9 w-full rounded-md border border-border bg-background px-2.5 text-sm text-foreground outline-none"
              >
                {sources.map((source) => (
                  <option key={source} value={source}>
                    {formatToken(source)}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-xs font-medium text-muted-foreground">
              Adapter
              <Input
                value={toolForm.adapter}
                onChange={(event) => updateForm("adapter", event.target.value)}
                className="mt-1"
              />
            </label>
            <label className="space-y-1 text-xs font-medium text-muted-foreground">
              Risk
              <select
                value={toolForm.risk}
                onChange={(event) => updateForm("risk", event.target.value as CompanyToolRisk)}
                className="mt-1 h-9 w-full rounded-md border border-border bg-background px-2.5 text-sm text-foreground outline-none"
              >
                {risks.map((risk) => (
                  <option key={risk} value={risk}>
                    {formatToken(risk)}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-xs font-medium text-muted-foreground">
              Server key
              <Input
                data-testid="company-tools-server-key"
                value={toolForm.serverKey}
                onChange={(event) => updateForm("serverKey", event.target.value)}
                placeholder="gbrain"
                className="mt-1"
              />
            </label>
            <label className="space-y-1 text-xs font-medium text-muted-foreground">
              Tool name
              <Input
                data-testid="company-tools-tool-name"
                value={toolForm.toolName}
                onChange={(event) => updateForm("toolName", event.target.value)}
                placeholder="query"
                className="mt-1"
              />
            </label>
            <label className="space-y-1 text-xs font-medium text-muted-foreground md:col-span-2">
              Render JSON
              <Textarea
                data-testid="company-tools-render"
                value={toolForm.render}
                onChange={(event) => updateForm("render", event.target.value)}
                className="mt-1 min-h-28 font-mono text-xs"
              />
            </label>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              onClick={handleCreateTool}
              disabled={createTool.isPending || !toolForm.key.trim() || !toolForm.label.trim() || !toolForm.adapter.trim()}
            >
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              {createTool.isPending ? "Adding..." : "Add tool"}
            </Button>
            {formError ? <span className="text-xs text-destructive">{formError}</span> : null}
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Presets
        </div>
        <div className="rounded-md border border-border px-4 py-4">
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
            <label className="space-y-1 text-xs font-medium text-muted-foreground">
              Agent
              <select
                data-testid="company-tools-preset-agent"
                value={selectedPresetAgentId}
                onChange={(event) => {
                  setSelectedPresetAgentId(event.target.value);
                  setPresetNotice(null);
                }}
                className="mt-1 h-9 w-full rounded-md border border-border bg-background px-2.5 text-sm text-foreground outline-none"
              >
                <option value="">Select agent</option>
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-xs font-medium text-muted-foreground">
              Preset
              <select
                data-testid="company-tools-preset"
                value={selectedPresetId}
                onChange={(event) => {
                  setSelectedPresetId(event.target.value);
                  setPresetNotice(null);
                }}
                className="mt-1 h-9 w-full rounded-md border border-border bg-background px-2.5 text-sm text-foreground outline-none"
              >
                <option value="">Select preset</option>
                {presets.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex items-end">
              <Button
                size="sm"
                onClick={() => applyPreset.mutate()}
                disabled={!selectedPresetAgentId || !selectedPresetId || applyPreset.isPending}
              >
                <Save className="mr-1.5 h-3.5 w-3.5" />
                {applyPreset.isPending ? "Applying..." : "Apply preset"}
              </Button>
            </div>
          </div>
          {presetNotice ? <p className="mt-3 text-xs text-muted-foreground">{presetNotice}</p> : null}
          {applyPreset.isError ? (
            <p className="mt-3 text-xs text-destructive">
              {applyPreset.error instanceof Error ? applyPreset.error.message : "Failed to apply preset"}
            </p>
          ) : null}
        </div>
      </section>

      <section className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Access Matrix
          </div>
          <Button
            size="sm"
            onClick={() => saveGrants.mutate()}
            disabled={dirtyCount === 0 || saveGrants.isPending}
          >
            <Save className="mr-1.5 h-3.5 w-3.5" />
            {saveGrants.isPending ? "Applying..." : "Apply changes"}
          </Button>
        </div>

        <div className="overflow-x-auto rounded-md border border-border">
          <table className="min-w-full table-fixed text-sm">
            <thead className="bg-muted/40">
              <tr>
                <th className="w-64 px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Tool
                </th>
                {agents.map((agent) => (
                  <th
                    key={agent.id}
                    className="w-44 px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground"
                  >
                    <span className="block truncate">{agent.name}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td className="px-3 py-5 text-sm text-muted-foreground" colSpan={Math.max(agents.length + 1, 1)}>
                    Loading tools...
                  </td>
                </tr>
              ) : (matrix?.tools ?? []).length === 0 ? (
                <tr>
                  <td className="px-3 py-5 text-sm text-muted-foreground" colSpan={Math.max(agents.length + 1, 1)}>
                    No tools yet.
                  </td>
                </tr>
              ) : (
                (matrix?.tools ?? []).map((tool) => (
                  <tr key={tool.id} className="border-t border-border">
                    <td className="px-3 py-3 align-top">
                      <div className="font-medium">{tool.label}</div>
                      <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{tool.key}</div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        <span className="rounded-sm border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
                          {formatToken(tool.source)}
                        </span>
                        <span
                          className={cn(
                            "rounded-sm border px-1.5 py-0.5 text-[11px]",
                            tool.risk === "read"
                              ? "border-emerald-500/30 text-emerald-700 dark:text-emerald-300"
                              : "border-amber-500/30 text-amber-700 dark:text-amber-300",
                          )}
                        >
                          {formatToken(tool.risk)}
                        </span>
                      </div>
                    </td>
                    {agents.map((agent) => {
                      const cell = `${agent.id}:${tool.id}`;
                      const value = draft[cell] ?? grantByCell.get(cell) ?? "off";
                      return (
                        <td key={cell} className="px-3 py-3 align-top">
                          <select
                            aria-label={`${agent.name} ${tool.label} access`}
                            value={value}
                            onChange={(event) => setCellMode(agent.id, tool.id, event.target.value as ToolAccessMode)}
                            className={cn(
                              "h-8 w-full rounded-md border border-border bg-background px-2 text-sm outline-none",
                              draft[cell] ? "border-primary/50 bg-primary/5" : null,
                            )}
                          >
                            {modes.filter((mode) => tool.supportedModes.includes(mode)).map((mode) => (
                              <option key={mode} value={mode}>
                                {formatMode(mode)}
                              </option>
                            ))}
                          </select>
                        </td>
                      );
                    })}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {saveGrants.isError ? (
          <p className="text-xs text-destructive">
            {saveGrants.error instanceof Error ? saveGrants.error.message : "Failed to apply grants"}
          </p>
        ) : null}
        {grantNotice ? <p className="text-xs text-muted-foreground">{grantNotice}</p> : null}
      </section>
    </div>
  );
}
