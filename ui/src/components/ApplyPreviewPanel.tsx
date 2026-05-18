import { useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import type {
  AgentCapabilityApplyPreviewProposal,
  AgentCapabilityApplyPreviewRequestInput,
  AgentCapabilityMcpServerChangeRow,
  AgentCapabilityRefChangeRow,
} from "@paperclipai/shared";
import { Button } from "@/components/ui/button";

interface ApplyPreviewPanelProps {
  draftConfig: AgentCapabilityApplyPreviewRequestInput["draftConfig"] | undefined;
  draftError: string | null;
  previewFn: (body: AgentCapabilityApplyPreviewRequestInput) => Promise<AgentCapabilityApplyPreviewProposal>;
  /** Optional observer for parent components that wire the proposal into the G.3 apply panel. */
  onProposal?: (proposal: AgentCapabilityApplyPreviewProposal | null) => void;
}

function riskBadgeClass(risk: "low" | "medium" | "high"): string {
  if (risk === "high") {
    return "rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-red-900 dark:bg-red-950/40 dark:text-red-100";
  }
  if (risk === "medium") {
    return "rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-900 dark:bg-amber-950/40 dark:text-amber-100";
  }
  return "rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100";
}

function McpRow({ row }: { row: AgentCapabilityMcpServerChangeRow }) {
  return (
    <div className="rounded-md border border-border bg-background px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{row.displayName}</span>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{row.id}</span>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{row.transport}</span>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          desired: {row.desiredState}
        </span>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          live: {row.liveState}
        </span>
        <span className={riskBadgeClass(row.riskClass)}>risk: {row.riskClass}</span>
        <span className="rounded-full border border-amber-300/70 bg-amber-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-900 dark:border-amber-400/40 dark:bg-amber-950/30 dark:text-amber-100">
          approval required for live apply
        </span>
      </div>
      {row.changedFields.length > 0 && (
        <p className="mt-1 text-xs text-muted-foreground">
          Changed fields: {row.changedFields.join(", ")}
        </p>
      )}
      {row.requiredSecretNames.length > 0 && (
        <p className="mt-1 text-xs text-muted-foreground">
          Required named secrets: {row.requiredSecretNames.join(", ")}
        </p>
      )}
      {row.missingSecretNames.length > 0 && (
        <p className="mt-1 text-xs text-amber-700 dark:text-amber-200">
          Missing named secrets: {row.missingSecretNames.join(", ")} — bind these before any approval-gated live apply.
        </p>
      )}
    </div>
  );
}

function RefRow({ row, label }: { row: AgentCapabilityRefChangeRow; label: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-sm">
      <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="font-medium">{row.ref}</span>
      <span className={riskBadgeClass(row.riskClass)}>risk: {row.riskClass}</span>
    </div>
  );
}

export function ApplyPreviewPanel({ draftConfig, draftError, previewFn, onProposal }: ApplyPreviewPanelProps) {
  const mutation = useMutation({
    mutationFn: () =>
      previewFn({
        draftConfig: draftConfig ?? undefined,
      }),
  });

  const proposal = mutation.data ?? null;
  const errorMessage = mutation.error instanceof Error ? mutation.error.message : null;

  useEffect(() => {
    onProposal?.(proposal);
  }, [proposal, onProposal]);

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-border bg-muted/20 p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm font-medium">Apply Preview (dry-run)</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Dry-run only — no live MCP install, connect, execute, apply, or external action occurs from this preview.
              Live capability apply remains approval-gated and is not performed here.
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending || Boolean(draftError)}
            aria-label="Run dry-run Apply Preview"
          >
            {mutation.isPending ? "Computing dry-run…" : "Run dry-run preview"}
          </Button>
        </div>
        {draftError && (
          <p className="mt-2 text-xs text-destructive">
            Cannot run preview while Advanced JSON is invalid: {draftError}. No live action occurred.
          </p>
        )}
      </div>

      {mutation.isPending && (
        <p className="rounded-md border border-dashed border-border p-3 text-sm text-muted-foreground" role="status">
          Computing dry-run proposal… No live MCP install/connect/execute happens during this preview.
        </p>
      )}

      {errorMessage && !mutation.isPending && (
        <div
          className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
          role="alert"
        >
          <p className="font-medium">Failed to compute Apply Preview. No live action occurred.</p>
          <p className="mt-1 text-xs text-destructive/80">{errorMessage}</p>
        </div>
      )}

      {proposal && !mutation.isPending && (
        <div className="space-y-3">
          <div className="rounded-md border border-border bg-background/60 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium">{proposal.copy.headline}</p>
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                {proposal.status === "no_op" ? "no changes" : "changes pending approval"}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{proposal.copy.dryRunNote}</p>
            <p className="mt-1 text-xs text-muted-foreground">{proposal.copy.safetyStatement}</p>
            <p className="mt-1 text-xs text-muted-foreground">Rollback: {proposal.copy.rollbackNote}</p>
            <dl className="mt-3 grid gap-2 sm:grid-cols-3">
              <div className="rounded-md border border-border bg-background/60 p-2">
                <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">Additions</dt>
                <dd className="text-sm font-semibold">{proposal.totals.additions}</dd>
              </div>
              <div className="rounded-md border border-border bg-background/60 p-2">
                <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">Removals</dt>
                <dd className="text-sm font-semibold">{proposal.totals.removals}</dd>
              </div>
              <div className="rounded-md border border-border bg-background/60 p-2">
                <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">Updates</dt>
                <dd className="text-sm font-semibold">{proposal.totals.updates}</dd>
              </div>
            </dl>
            <p className="mt-2 text-[11px] text-muted-foreground">
              Risk: {proposal.riskSummary.highRiskCount} high / {proposal.riskSummary.mediumRiskCount} medium /{" "}
              {proposal.riskSummary.lowRiskCount} low. Identity:{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-[10px]">{proposal.proposalIdentity}</code>
            </p>
            {proposal.missingSecretNames.length > 0 && (
              <p className="mt-2 text-xs text-amber-700 dark:text-amber-200">
                Missing named secrets across draft: {proposal.missingSecretNames.join(", ")}. Secret values are never
                shown; only named references are tracked. Bind these before any approval-gated live apply.
              </p>
            )}
            {proposal.inheritedContext && (
              <p className="mt-2 text-xs text-muted-foreground">Inheritance: {proposal.inheritedContext.note}</p>
            )}
          </div>

          {proposal.status === "no_op" ? (
            <p className="rounded-md border border-dashed border-border p-3 text-sm text-muted-foreground">
              No-op: draft matches the persisted desired config. No live MCP install, connect, execute, apply, or
              external action would occur on approval.
            </p>
          ) : (
            <div className="space-y-3">
              {proposal.mcpServers.additions.length > 0 && (
                <section aria-labelledby="apply-preview-additions" className="space-y-2">
                  <h3
                    id="apply-preview-additions"
                    className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                  >
                    MCP additions
                  </h3>
                  {proposal.mcpServers.additions.map((row) => (
                    <McpRow key={`add-${row.id}`} row={row} />
                  ))}
                </section>
              )}
              {proposal.mcpServers.updates.length > 0 && (
                <section aria-labelledby="apply-preview-updates" className="space-y-2">
                  <h3
                    id="apply-preview-updates"
                    className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                  >
                    MCP updates
                  </h3>
                  {proposal.mcpServers.updates.map((row) => (
                    <McpRow key={`update-${row.id}`} row={row} />
                  ))}
                </section>
              )}
              {proposal.mcpServers.removals.length > 0 && (
                <section aria-labelledby="apply-preview-removals" className="space-y-2">
                  <h3
                    id="apply-preview-removals"
                    className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                  >
                    MCP removals
                  </h3>
                  {proposal.mcpServers.removals.map((row) => (
                    <McpRow key={`remove-${row.id}`} row={row} />
                  ))}
                </section>
              )}
              {(proposal.skillRefs.additions.length > 0 || proposal.skillRefs.removals.length > 0) && (
                <section aria-labelledby="apply-preview-skill-refs" className="space-y-2">
                  <h3
                    id="apply-preview-skill-refs"
                    className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                  >
                    Skill references
                  </h3>
                  {proposal.skillRefs.additions.map((row) => (
                    <RefRow key={`skill-add-${row.ref}`} row={row} label="add" />
                  ))}
                  {proposal.skillRefs.removals.map((row) => (
                    <RefRow key={`skill-remove-${row.ref}`} row={row} label="remove" />
                  ))}
                </section>
              )}
              {(proposal.toolRefs.additions.length > 0 || proposal.toolRefs.removals.length > 0) && (
                <section aria-labelledby="apply-preview-tool-refs" className="space-y-2">
                  <h3
                    id="apply-preview-tool-refs"
                    className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                  >
                    Tool references
                  </h3>
                  {proposal.toolRefs.additions.map((row) => (
                    <RefRow key={`tool-add-${row.ref}`} row={row} label="add" />
                  ))}
                  {proposal.toolRefs.removals.map((row) => (
                    <RefRow key={`tool-remove-${row.ref}`} row={row} label="remove" />
                  ))}
                </section>
              )}
              {proposal.expectedEffects.length > 0 && (
                <section aria-labelledby="apply-preview-effects" className="space-y-1">
                  <h3
                    id="apply-preview-effects"
                    className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                  >
                    Expected effects (on later approved live apply)
                  </h3>
                  <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                    {proposal.expectedEffects.map((line, index) => (
                      <li key={index}>{line}</li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          )}

          <div className="rounded-md border border-dashed border-border bg-background/60 p-3 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">Request live apply</p>
            <p className="mt-1">
              Requesting live apply is a later, gated slice. Approval, materialization, and live MCP install/connect/
              execute are not available from this preview.
            </p>
            <div className="mt-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled
                aria-disabled="true"
                aria-label="Request live apply (disabled until later approval-gated slice)"
                title="Disabled: live apply is a later approval-gated slice"
              >
                Request live apply (later, approval-gated)
              </Button>
            </div>
          </div>
        </div>
      )}

      {!proposal && !mutation.isPending && !errorMessage && (
        <p className="rounded-md border border-dashed border-border p-3 text-sm text-muted-foreground">
          Click <strong>Run dry-run preview</strong> to compute the sanitized proposal. No live MCP install,
          connect, execute, apply, or external action will happen.
        </p>
      )}
    </div>
  );
}
