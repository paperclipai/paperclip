import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { CheckCircle2, KeyRound } from "lucide-react";
import type { McpJsonImportDraft, McpJsonImportPreview } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toolsApi } from "@/api/tools";
import { ToolsPageHeader, ErrorState } from "./shared";

const SAMPLE_CONFIG = `{
  "mcpServers": {
    "github": {
      "command": "npx -y @modelcontextprotocol/server-github",
      "env": { "GITHUB_TOKEN": "ghp_..." }
    }
  }
}`;

/** Turn an env/header key (e.g. `GITHUB_TOKEN`) into a friendly field label. */
function humanizeKey(raw: string): string {
  const cleaned = raw.replace(/[_-]+/g, " ").trim().toLowerCase();
  if (!cleaned) return "Key";
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function draftSummary(draft: McpJsonImportDraft): string {
  const keyCount = draft.credentialRefs.length;
  const where = draft.transport === "local_stdio" ? "Runs in your workspace" : "Connects over the web";
  if (keyCount === 0) return `${where}  ·  no keys needed`;
  return `${where}  ·  needs ${keyCount} ${keyCount === 1 ? "key" : "keys"}`;
}

/**
 * M8a — "Paste a config" tab on the Advanced door (PAP-10862, plan D8).
 *
 * A thin, honest surface over `POST /companies/:id/tools/mcp/import-json`: paste
 * the snippet a README tells you to copy, and we parse it into a friendly
 * preview (humanized field labels, never the raw transport jargon). This is one
 * of the two M8 screens where "MCP" vocabulary is allowed (PAP-10827 vocab map).
 */
export function PasteConfigTab({ companyId }: { companyId: string }) {
  const [draftText, setDraftText] = useState("");
  const [preview, setPreview] = useState<McpJsonImportPreview | null>(null);

  const importMutation = useMutation({
    mutationFn: (mcpJson: string) => toolsApi.importMcpJson(companyId, { mcpJson }),
    onSuccess: (result) => setPreview(result),
  });

  const drafts = preview?.drafts ?? [];
  const canSubmit = draftText.trim().length > 0 && !importMutation.isPending;

  const localParseError = useMemo(() => {
    const trimmed = draftText.trim();
    if (!trimmed) return null;
    try {
      JSON.parse(trimmed);
      return null;
    } catch {
      return "That doesn't look like valid JSON yet — paste the whole snippet, including the outer braces.";
    }
  }, [draftText]);

  return (
    <div className="space-y-5">
      <ToolsPageHeader
        title="Paste a config"
        description="For a tool that isn't in the gallery. Paste the MCP config snippet from the tool's README and we'll turn it into a friendly setup."
      />

      <div className="space-y-2">
        <Textarea
          value={draftText}
          onChange={(event) => {
            setDraftText(event.target.value);
            if (preview) setPreview(null);
          }}
          spellCheck={false}
          rows={10}
          placeholder={SAMPLE_CONFIG}
          className="min-h-[220px] bg-slate-900 font-mono text-[13px] leading-relaxed text-slate-100 placeholder:text-slate-500 focus-visible:ring-slate-400"
        />
        {localParseError ? (
          <p className="text-xs text-amber-600">{localParseError}</p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Paste an MCP config — the snippet a README tells you to copy.
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          onClick={() => importMutation.mutate(draftText)}
          disabled={!canSubmit || Boolean(localParseError)}
        >
          {importMutation.isPending ? "Checking…" : "Check & continue"}
        </Button>
        <span className="text-xs text-muted-foreground">
          We'll read it and show what we found before anything is saved.
        </span>
      </div>

      {importMutation.isError ? <ErrorState error={importMutation.error} /> : null}

      {preview ? (
        drafts.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">
            We couldn't find an app in that config. Double-check you pasted the whole snippet.
          </div>
        ) : (
          <div className="space-y-3">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              We found {drafts.length} {drafts.length === 1 ? "app" : "apps"} in that config
            </h3>
            {drafts.map((draft, index) => (
              <DraftCard key={`${draft.name}-${index}`} draft={draft} />
            ))}
            <p className="text-xs text-muted-foreground">
              We humanized the field names from the config. Next, you'll add the keys and pick the actions you want on.
            </p>
          </div>
        )
      ) : null}
    </div>
  );
}

function DraftCard({ draft }: { draft: McpJsonImportDraft }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="font-semibold text-foreground">{draft.name}</div>
          <div className="text-xs text-muted-foreground">{draftSummary(draft)}</div>
        </div>
      </div>

      {draft.credentialRefs.length > 0 ? (
        <div className="mt-4 space-y-3">
          {draft.credentialRefs.map((ref) => (
            <div key={`${ref.name}-${ref.key}`} className="space-y-1">
              <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
                {humanizeKey(ref.key || ref.name)}
              </div>
              <div className="flex items-center gap-2">
                <code className="rounded border border-border bg-muted/40 px-2 py-1 font-mono text-[11px] text-muted-foreground">
                  {ref.key}
                </code>
                <span className="text-[11px] text-muted-foreground">Field made from the config above</span>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">No keys needed for this one.</p>
      )}

      {draft.warnings.length > 0 ? (
        <ul className="mt-4 space-y-1 border-t border-border pt-3">
          {draft.warnings.map((warning, i) => (
            <li key={i} className="text-xs text-amber-600">
              {warning}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
