import { useId, useRef, useState } from "react";
import { isValidExistingBranchName } from "@paperclipai/shared";
import { Check, ChevronDown, GitBranch, Loader2, TriangleAlert } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { SystemNoticeMetadataSections } from "./SystemNotice";
import { cn } from "../lib/utils";
import { useTranslation } from "@/i18n";

export interface WorkspaceBaseRefRecoveryNoticeProps {
  requestedRef: string;
  repository: string;
  /** Only supply a default confirmed by the repository, never a guessed main/master. */
  defaultBranch?: string | null;
  agentName: string;
  /** Verified provenance, when available. */
  configuredBy?: string | null;
  taskOverride?: boolean;
  failureKind?: "missing_branch" | "unresolved_ref";
  unavailableReason?: string | null;
  /** Resolve only after both the task setting and retry have server receipts. */
  onRepair: (branch: string) => Promise<void>;
}

/** Inline task repair, also used by the interactive Storybook preview. */
export function WorkspaceBaseRefRecoveryNotice({
  requestedRef, repository, defaultBranch, agentName, configuredBy,
  taskOverride = true, failureKind = "unresolved_ref", unavailableReason, onRepair,
}: WorkspaceBaseRefRecoveryNoticeProps) {
  const { t } = useTranslation();
  const id = useId();
  const [editing, setEditing] = useState(!defaultBranch);
  const [branch, setBranch] = useState(defaultBranch ?? "");
  const [details, setDetails] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [repairedBranch, setRepairedBranch] = useState<string | null>(null);
  const inFlight = useRef(false);
  const changed = branch.trim().length > 0 && branch.trim() !== requestedRef;

  async function repair(nextBranch: string) {
    const value = nextBranch.trim();
    if (!value || value === requestedRef || unavailableReason || inFlight.current || repairedBranch) return;
    if (!isValidExistingBranchName(value)) {
      setError(t("workspaces.WorkspaceBaseRefRecoveryNotice.invalidBranch"));
      return;
    }
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      await onRepair(value);
      setRepairedBranch(value);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("workspaces.WorkspaceBaseRefRecoveryNotice.refreshTask"));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <section aria-labelledby={`${id}-title`} className="flex min-w-0 gap-3 rounded-lg border border-border bg-muted/20 p-4" data-testid="workspace-base-ref-recovery">
      {repairedBranch
        ? <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-(--status-task-icon-done)" />
        : <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-(--status-task-icon-blocked)" />}
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-col gap-1" role="status" aria-live="polite">
          <h2 id={`${id}-title`} className="break-words text-sm font-semibold">
            {repairedBranch ? t("workspaces.WorkspaceBaseRefRecoveryNotice.updated") : failureKind === "missing_branch" ? <>{t("workspaces.WorkspaceBaseRefRecoveryNotice.branchPrefix")} <code className="font-mono">{requestedRef}</code> {t("workspaces.WorkspaceBaseRefRecoveryNotice.notFound")}</> : <>{t("workspaces.WorkspaceBaseRefRecoveryNotice.couldntUse")} <code className="font-mono">{requestedRef}</code></>}
          </h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {repairedBranch
              ? <>{t("workspaces.WorkspaceBaseRefRecoveryNotice.repairedFrom")} <code className="font-mono text-foreground">{repairedBranch}</code>{t("workspaces.WorkspaceBaseRefRecoveryNotice.retryRequested", { agentName })}</>
              : <><span className="break-all text-foreground">{repository}</span>{failureKind === "missing_branch" ? <> {t("workspaces.WorkspaceBaseRefRecoveryNotice.noBranchNamed")} <code className="font-mono text-foreground">{requestedRef}</code>.</> : <> {t("workspaces.WorkspaceBaseRefRecoveryNotice.unresolved")}</>} {t("workspaces.WorkspaceBaseRefRecoveryNotice.agentNotStarted", { agentName })}</>}
          </p>
        </div>
        {!repairedBranch && (
          <>
            {defaultBranch && !editing && <p className="flex flex-wrap items-center gap-1.5 text-sm"><GitBranch aria-hidden className="size-4 text-muted-foreground" /><code className="font-mono">{defaultBranch}</code><span className="text-muted-foreground">{t("workspaces.WorkspaceBaseRefRecoveryNotice.defaultNote")}</span></p>}
            <p className="text-xs text-muted-foreground">{t("workspaces.WorkspaceBaseRefRecoveryNotice.changesOnly")}</p>
            {unavailableReason && <p id={`${id}-unavailable`} className="text-sm text-muted-foreground">{unavailableReason}</p>}
            {error && <p role="alert" id={`${id}-error`} className="text-sm text-destructive">{t("workspaces.WorkspaceBaseRefRecoveryNotice.confirmError", { error })}</p>}
            {editing ? (
              <form className="flex flex-col gap-3" onSubmit={event => { event.preventDefault(); void repair(branch); }}>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`${id}-branch`}>{t("workspaces.WorkspaceBaseRefRecoveryNotice.startingBranch")}</Label>
                  <Input id={`${id}-branch`} autoFocus value={branch} disabled={pending || Boolean(unavailableReason)} onChange={event => setBranch(event.target.value)} placeholder={t("workspaces.WorkspaceBaseRefRecoveryNotice.branchName")} className="font-mono" aria-describedby={error ? `${id}-error` : undefined} autoComplete="off" spellCheck={false} />
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  {defaultBranch ? <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => { setEditing(false); setError(null); }}>{t("workspaces.WorkspaceBaseRefRecoveryNotice.cancel")}</Button> : <span />}
                  <Button type="submit" size="sm" disabled={pending || !changed || Boolean(unavailableReason)} aria-describedby={unavailableReason ? `${id}-unavailable` : undefined}>
                    {pending && <Loader2 aria-hidden className="size-3.5 animate-spin motion-reduce:animate-none" />}{pending ? t("workspaces.WorkspaceBaseRefRecoveryNotice.savingRetry") : t("workspaces.WorkspaceBaseRefRecoveryNotice.saveRetry")}
                  </Button>
                </div>
              </form>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Button type="button" variant="ghost" size="sm" disabled={pending || Boolean(unavailableReason)} onClick={() => setEditing(true)}>{t("workspaces.WorkspaceBaseRefRecoveryNotice.chooseAnother")}</Button>
                <Button type="button" size="sm" disabled={pending || Boolean(unavailableReason) || defaultBranch === requestedRef} aria-describedby={unavailableReason ? `${id}-unavailable` : undefined} onClick={() => void repair(defaultBranch!)}>
                  {pending && <Loader2 aria-hidden className="size-3.5 animate-spin motion-reduce:animate-none" />}{pending ? t("workspaces.WorkspaceBaseRefRecoveryNotice.savingRetry") : t("workspaces.WorkspaceBaseRefRecoveryNotice.useBranchRetry", { branch: defaultBranch })}
                </Button>
              </div>
            )}
          </>
        )}
        <div>
          <Button type="button" variant="ghost" size="xs" className="text-muted-foreground" aria-expanded={details} aria-controls={`${id}-details`} onClick={() => setDetails(value => !value)}>
            {details ? t("workspaces.WorkspaceBaseRefRecoveryNotice.hideDetails") : t("workspaces.WorkspaceBaseRefRecoveryNotice.whyHappened")}<ChevronDown aria-hidden className={cn("size-3", details && "rotate-180")} />
          </Button>
          {details && <div id={`${id}-details`} className="mt-2 rounded-md border border-border bg-background">
            <SystemNoticeMetadataSections tone="neutral" sections={[{ rows: [
              { kind: "text", label: t("workspaces.WorkspaceBaseRefRecoveryNotice.setting"), value: taskOverride ? t("workspaces.WorkspaceBaseRefRecoveryNotice.taskBranch") : t("workspaces.WorkspaceBaseRefRecoveryNotice.workspaceBranch") },
              { kind: "code", label: t("workspaces.WorkspaceBaseRefRecoveryNotice.requestedBranch"), value: requestedRef },
              ...(configuredBy ? [{ kind: "text" as const, label: t("workspaces.WorkspaceBaseRefRecoveryNotice.setBy"), value: configuredBy }] : []),
              { kind: "text", label: t("workspaces.WorkspaceBaseRefRecoveryNotice.whyStopped"), value: taskOverride ? t("workspaces.WorkspaceBaseRefRecoveryNotice.stoppedTask") : t("workspaces.WorkspaceBaseRefRecoveryNotice.stoppedWorkspace") },
            ] }]} />
          </div>}
        </div>
      </div>
    </section>
  );
}
