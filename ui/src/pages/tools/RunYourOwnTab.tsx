import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, Plus, ShieldCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { queryKeys } from "@/lib/queryKeys";
import { toolsApi } from "@/api/tools";
import { useToast } from "@/context/ToastContext";
import { LoadingState, ErrorState, RelativeTime } from "./shared";

const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]*$/i;

/** Slugify a display name into a `safeKeyPattern`-valid template id. */
function toTemplateId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return slug;
}

/** Split a typed command line into command + args on whitespace. */
function splitCommand(raw: string): { command: string; args: string[] } {
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  return { command: parts[0] ?? "", args: parts.slice(1) };
}

type KeyRow = { id: number; value: string };

/**
 * M8b — "Run your own" tab on the Advanced door (PAP-10862, plan D8).
 *
 * Admin-only surface over P5a's command-template routes
 * (`POST /companies/:id/tools/stdio-templates`). Registers a command that
 * Paperclip will run in the company's isolated workspace and the keys it
 * expects. One of the two M8 screens where "MCP" vocabulary is allowed.
 */
export function RunYourOwnTab({ companyId }: { companyId: string }) {
  const qc = useQueryClient();
  const { pushToast } = useToast();

  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [keyRows, setKeyRows] = useState<KeyRow[]>([]);
  const [nextRowId, setNextRowId] = useState(1);

  const templates = useQuery({
    queryKey: queryKeys.tools.stdioTemplates(companyId),
    queryFn: () => toolsApi.listStdioTemplates(companyId),
  });

  const envKeys = useMemo(
    () => keyRows.map((row) => row.value.trim()).filter(Boolean),
    [keyRows],
  );
  const invalidKeys = envKeys.filter((key) => !ENV_KEY_RE.test(key));
  const parsed = splitCommand(command);
  const templateId = toTemplateId(name);
  const canSubmit =
    name.trim().length > 0 &&
    parsed.command.length > 0 &&
    templateId.length > 0 &&
    invalidKeys.length === 0;

  const createMutation = useMutation({
    mutationFn: () =>
      toolsApi.createStdioTemplate(companyId, {
        templateId,
        name: name.trim(),
        command: parsed.command,
        args: parsed.args,
        envKeys,
      }),
    onSuccess: () => {
      pushToast({ title: "Tool added", body: `"${name.trim()}" is ready to connect.`, tone: "success" });
      setName("");
      setCommand("");
      setKeyRows([]);
      qc.invalidateQueries({ queryKey: queryKeys.tools.stdioTemplates(companyId) });
    },
  });

  const addKeyRow = () => {
    setKeyRows((rows) => [...rows, { id: nextRowId, value: "" }]);
    setNextRowId((id) => id + 1);
  };

  const adminTemplates = (templates.data?.templates ?? []).filter((t) => t.source === "admin");

  return (
    <div className="space-y-6">
      <p className="max-w-2xl text-sm text-muted-foreground">
        For a tool that runs from a command. Paperclip runs it in your company's own isolated workspace.
        Administrators only.
      </p>

      <div className="space-y-5 rounded-lg border border-border bg-card p-5">
        <div className="space-y-1.5">
          <Label htmlFor="ryo-name">Name</Label>
          <Input
            id="ryo-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Acme tools"
            maxLength={160}
          />
          <p className="text-xs text-muted-foreground">What you'll call this tool in your apps list.</p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="ryo-command">Command</Label>
          <Input
            id="ryo-command"
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            placeholder="npx -y @acme/mcp-tool"
            spellCheck={false}
            className="bg-slate-900 font-mono text-(length:--text-compact) text-slate-100 placeholder:text-slate-500 focus-visible:ring-slate-400"
          />
          <p className="text-xs text-muted-foreground">The command that runs the tool. From the tool's README.</p>
        </div>

        <div className="space-y-2">
          <div className="flex items-baseline gap-2">
            <Label>Keys it needs</Label>
            <span className="text-xs text-muted-foreground">· optional, depends on the tool</span>
          </div>
          {keyRows.length > 0 ? (
            <div className="space-y-2">
              {keyRows.map((row) => {
                const value = row.value.trim();
                const invalid = value.length > 0 && !ENV_KEY_RE.test(value);
                return (
                  <div key={row.id} className="space-y-1">
                    <div className="flex items-center gap-2">
                      <Input
                        value={row.value}
                        onChange={(event) =>
                          setKeyRows((rows) =>
                            rows.map((r) => (r.id === row.id ? { ...r, value: event.target.value } : r)),
                          )
                        }
                        placeholder="API_KEY"
                        spellCheck={false}
                        className={`font-mono text-(length:--text-compact) ${invalid ? "border-destructive" : ""}`}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label="Remove key"
                        onClick={() => setKeyRows((rows) => rows.filter((r) => r.id !== row.id))}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                    {invalid ? (
                      <p className="text-xs text-destructive">
                        Use letters, numbers and underscores, starting with a letter or underscore (e.g. API_KEY).
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : null}
          <Button type="button" variant="outline" size="sm" onClick={addKeyRow} className="gap-1.5">
            <Plus className="h-3.5 w-3.5" />
            Add a key
          </Button>
        </div>

        <div className="flex items-start gap-2.5 rounded-md bg-muted/50 px-3 py-2.5">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
          <div className="text-xs">
            <p className="font-medium text-foreground">
              This runs in your company's own workspace, isolated from everything else.
            </p>
            <p className="mt-0.5 flex items-center gap-1 text-muted-foreground">
              <Lock className="h-3 w-3" />
              Only administrators see this option.
            </p>
          </div>
        </div>

        {createMutation.isError ? <ErrorState error={createMutation.error} /> : null}

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => createMutation.mutate()} disabled={!canSubmit || createMutation.isPending}>
            {createMutation.isPending ? "Adding…" : "Check & continue"}
          </Button>
          <span className="text-xs text-muted-foreground">
            Paperclip will register the command and the keys it needs.
          </span>
        </div>
      </div>

      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-foreground">Your own tools</h3>
        {templates.isLoading ? (
          <LoadingState />
        ) : templates.isError ? (
          <ErrorState error={templates.error} onRetry={() => templates.refetch()} />
        ) : adminTemplates.length === 0 ? (
          <p className="text-sm text-muted-foreground">You haven't added any of your own tools yet.</p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-left text-(length:--text-micro) font-semibold uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-2.5">Name</th>
                  <th className="px-4 py-2.5">Command</th>
                  <th className="px-4 py-2.5">Keys</th>
                  <th className="px-4 py-2.5">Added</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {adminTemplates.map((template) => (
                  <RunYourOwnRow key={template.templateId} companyId={companyId} template={template} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function RunYourOwnRow({
  companyId,
  template,
}: {
  companyId: string;
  template: import("@/api/tools").StdioTemplateSummary;
}) {
  const qc = useQueryClient();
  const { pushToast } = useToast();
  const disableMutation = useMutation({
    mutationFn: () => toolsApi.disableStdioTemplate(companyId, template.templateId),
    onSuccess: () => {
      pushToast({ title: "Tool turned off", tone: "success" });
      qc.invalidateQueries({ queryKey: queryKeys.tools.stdioTemplates(companyId) });
    },
    onError: (error) => {
      pushToast({
        title: "Couldn't turn it off",
        body: error instanceof Error ? error.message : undefined,
        tone: "error",
      });
    },
  });
  const disabled = template.status === "disabled";
  const fullCommand = [template.command ?? "", ...(template.args ?? [])].join(" ").trim();

  return (
    <tr className="border-b border-border last:border-0">
      <td className="px-4 py-3">
        <div className="font-medium text-foreground">{template.name}</div>
        {disabled ? <Badge variant="outline">off</Badge> : null}
      </td>
      <td className="px-4 py-3">
        <code className="font-mono text-(length:--text-micro) text-muted-foreground">{fullCommand || "—"}</code>
      </td>
      <td className="px-4 py-3 text-muted-foreground">
        {template.envKeys.length > 0 ? template.envKeys.join(", ") : "none"}
      </td>
      <td className="px-4 py-3">
        <RelativeTime value={template.createdAt} />
      </td>
      <td className="px-4 py-3 text-right">
        {disabled ? null : (
          <Button
            variant="outline"
            size="sm"
            onClick={() => disableMutation.mutate()}
            disabled={disableMutation.isPending}
          >
            Turn off
          </Button>
        )}
      </td>
    </tr>
  );
}
