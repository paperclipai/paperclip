import { resolveUiMessage, uiErrorDescriptor, type UiMessageDescriptor } from "@/lib/localized-ui-error";
import { t, useTranslation, Trans } from "@/i18n";
import { useId, useRef, useState } from "react";
import { isValidExistingBranchName } from "@paperclipai/shared";
import { Check, ChevronDown, GitBranch, Loader2, TriangleAlert } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { SystemNoticeMetadataSections } from "./SystemNotice";
import { cn } from "../lib/utils";

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
  useTranslation("task-components");
  const id = useId();
  const [editing, setEditing] = useState(!defaultBranch);
  const [branch, setBranch] = useState(defaultBranch ?? "");
  const [details, setDetails] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<UiMessageDescriptor | { raw: string } | null>(null);
  const [repairedBranch, setRepairedBranch] = useState<string | null>(null);
  const inFlight = useRef(false);
  const changed = branch.trim().length > 0 && branch.trim() !== requestedRef;

  async function repair(nextBranch: string) {
    const value = nextBranch.trim();
    if (!value || value === requestedRef || unavailableReason || inFlight.current || repairedBranch) return;
    if (!isValidExistingBranchName(value)) {
      setError({ key: "final-components-a:enterAValidBranchName_323f9b63" });
      return;
    }
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      await onRepair(value);
      setRepairedBranch(value);
    } catch (cause) {
      setError(cause instanceof Error ? uiErrorDescriptor(cause) ?? { raw: cause.message } : { key: "final-components-a:refreshTheTaskToCheck_bd02447f" });
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
            {repairedBranch ? t("task-components:branchUpdatedRetryRequested_16c9692b") : failureKind === "missing_branch" ? <><Trans ns="task-components" i18nKey="sentence_c2b62b40e42e" components={{ part1: <>{<code className="font-mono">{requestedRef}</code>}</> }} /></> : <>{t("task-components:couldnTUseBranch_710df7a1")}{" "}<code className="font-mono">{requestedRef}</code></>}
          </h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {repairedBranch
              ? <><Trans ns="task-components" i18nKey="sentence_99eaa08eb2ca" components={{ part1: <>{<code className="font-mono text-foreground">{repairedBranch}</code>}</>, part2: <>{agentName}</> }} /></>
              : <><span className="break-all text-foreground">{repository}</span>{failureKind === "missing_branch" ? <><Trans ns="task-components" i18nKey="sentence_e234c3e15fd1" components={{ part1: <>{<code className="font-mono text-foreground">{requestedRef}</code>}</> }} /></> : (" " + t("task-components:couldNotResolveTheStartingBranchCheck_5242e9f8"))} {t("final-components-a:agentHasnTStarted_3b720ddd", { agent: agentName })}</>}
          </p>
        </div>
        {!repairedBranch && (
          <>
            {defaultBranch && !editing && <p className="flex flex-wrap items-center gap-1.5 text-sm"><GitBranch aria-hidden className="size-4 text-muted-foreground" /><code className="font-mono">{defaultBranch}</code><span className="text-muted-foreground">{t("task-components:isTheRepositorySDefaultBranch_f28e4c74")}</span></p>}
            <p className="text-xs text-muted-foreground">{t("task-components:changesOnlyThisTaskSStartingBranch_112966a4")}</p>
            {unavailableReason && <p id={`${id}-unavailable`} className="text-sm text-muted-foreground">{unavailableReason}</p>}
            {error && <p role="alert" id={`${id}-error`} className="text-sm text-destructive"><Trans ns="task-components" i18nKey="sentence_1be10a257072" components={{ part1: <>{error && ("raw" in error ? error.raw : resolveUiMessage(error))}</> }} /></p>}
            {editing ? (
              <form className="flex flex-col gap-3" onSubmit={event => { event.preventDefault(); void repair(branch); }}>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`${id}-branch`}>{t("task-components:startingBranch_8abd0fed")}</Label>
                  <Input id={`${id}-branch`} autoFocus value={branch} disabled={pending || Boolean(unavailableReason)} onChange={event => setBranch(event.target.value)} placeholder={t("task-components:branchName_06f6bb71")} className="font-mono" aria-describedby={error ? `${id}-error` : undefined} autoComplete="off" spellCheck={false} />
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  {defaultBranch ? <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => { setEditing(false); setError(null); }}>{t("task-components:cancel_19766ed6")}</Button> : <span />}
                  <Button type="submit" size="sm" disabled={pending || !changed || Boolean(unavailableReason)} aria-describedby={unavailableReason ? `${id}-unavailable` : undefined}>
                    {pending && <Loader2 aria-hidden className="size-3.5 animate-spin motion-reduce:animate-none" />}{pending ? t("task-components:savingRequestingRetry_026ac8fe") : t("task-components:saveBranchRetry_5949e61b")}
                  </Button>
                </div>
              </form>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Button type="button" variant="ghost" size="sm" disabled={pending || Boolean(unavailableReason)} onClick={() => setEditing(true)}>{t("task-components:chooseAnotherBranch_2b88b70b")}</Button>
                <Button type="button" size="sm" disabled={pending || Boolean(unavailableReason) || defaultBranch === requestedRef} aria-describedby={unavailableReason ? `${id}-unavailable` : undefined} onClick={() => void repair(defaultBranch!)}>
                  {pending && <Loader2 aria-hidden className="size-3.5 animate-spin motion-reduce:animate-none" />}{pending ? t("task-components:savingRequestingRetry_026ac8fe") : t("task-components:useRetry_69877d1d", { value1: defaultBranch })}
                </Button>
              </div>
            )}
          </>
        )}
        <div>
          <Button type="button" variant="ghost" size="xs" className="text-muted-foreground" aria-expanded={details} aria-controls={`${id}-details`} onClick={() => setDetails(value => !value)}>
            {details ? t("task-components:hideDetails_c9722a7a") : t("task-components:whyDidThisHappen_17ae9431")}<ChevronDown aria-hidden className={cn("size-3", details && "rotate-180")} />
          </Button>
          {details && <div id={`${id}-details`} className="mt-2 rounded-md border border-border bg-background">
            <SystemNoticeMetadataSections tone="neutral" sections={[{ rows: [
              { kind: "text", label: t("task-components:setting_818cd8d9"), value: taskOverride ? t("final-components-a:taskSpecificStartingBranch_b33fb63d") : t("final-components-a:workspaceStartingBranch_217ff4b3") },
              { kind: "code", label: t("task-components:requestedBranch_8e1a0b31"), value: requestedRef },
              ...(configuredBy ? [{ kind: "text" as const, label: t("task-components:setBy_bd6cc9a4"), value: configuredBy }] : []),
              { kind: "text", label: t("task-components:whyItStopped_ba4d9dce"), value: taskOverride ? t("final-components-a:anExplicitTaskBranchOverrides_544cc3b7") : t("final-components-a:theConfiguredStartingBranchMust_77f43f7f") },
            ] }]} />
          </div>}
        </div>
      </div>
    </section>
  );
}
