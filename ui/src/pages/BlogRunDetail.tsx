import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { blogRunsApi, type BlogRunDetail as BlogRunDetailRecord } from "../api/blogRuns";
import { issuesApi } from "../api/issues";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { cn, relativeTime } from "../lib/utils";
import { Button } from "@/components/ui/button";

function summarizeState(run: BlogRunDetailRecord["run"]) {
  if (run.status === "failed") return { label: "Failed", tone: "danger" as const };
  if (run.status === "review_required" || run.status === "human_review_backlog") {
    return { label: "Needs review", tone: "warning" as const };
  }
  if (run.status === "publish_approval_pending") {
    return { label: "Awaiting approval", tone: "warning" as const };
  }
  if (run.status === "public_verify_running" || run.currentStep === "public_verify") {
    return { label: "Public verify", tone: "active" as const };
  }
  if (run.status === "publish_running" || run.currentStep === "publish") {
    return { label: "Publishing", tone: "active" as const };
  }
  if (run.currentStep) {
    return { label: run.currentStep.replaceAll("_", " "), tone: "active" as const };
  }
  return { label: run.status.replaceAll("_", " "), tone: "neutral" as const };
}

function toneClass(tone: "active" | "warning" | "danger" | "neutral") {
  if (tone === "active") return "border-cyan-500/20 bg-cyan-500/[0.08] text-cyan-700 dark:text-cyan-300";
  if (tone === "warning") return "border-amber-500/20 bg-amber-500/[0.10] text-amber-700 dark:text-amber-300";
  if (tone === "danger") return "border-red-500/20 bg-red-500/[0.10] text-red-700 dark:text-red-300";
  return "border-border/70 bg-muted/30 text-muted-foreground";
}

function summaryChip(label: string, value: string) {
  return (
    <span className="inline-flex items-center rounded-full border border-border/60 bg-background/70 px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
      {label}: {value.replaceAll("_", " ")}
    </span>
  );
}

function blockerText(detail: BlogRunDetailRecord) {
  if (detail.run.failedReason) return detail.run.failedReason;
  const latestAttempt = detail.attempts[detail.attempts.length - 1];
  if (latestAttempt?.errorMessage) return latestAttempt.errorMessage;
  const latestApproval = detail.approvals[0];
  if (detail.run.status === "publish_approval_pending" && latestApproval?.targetSlug) {
    return `approval target: ${latestApproval.targetSlug}`;
  }
  if (latestApproval?.targetSlug) {
    return `approved for ${latestApproval.targetSlug}`;
  }
  return null;
}

function deriveApprovalState(detail: BlogRunDetailRecord) {
  if (detail.run.status === "publish_approval_pending") return "pending";
  if (detail.approvals.find((entry) => !entry.revokedAt)) return "approved";
  return "not_requested";
}

function derivePublishState(detail: BlogRunDetailRecord) {
  if (detail.run.currentStep === "publish" || detail.run.status === "publish_running") return "running";
  if (detail.run.wordpressPostId || detail.run.publishedUrl) return "published";
  if (detail.run.publishIdempotencyKey) return "ready";
  return "idle";
}

function deriveVerifyState(detail: BlogRunDetailRecord) {
  if (detail.run.status === "public_verified") return "verified";
  if (detail.run.currentStep === "public_verify" || detail.run.status === "public_verify_running") return "running";
  if (detail.run.status === "published") return "pending";
  return "idle";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function BlogRunDetail() {
  const { runId } = useParams<{ runId: string }>();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [resumeReviewForm, setResumeReviewForm] = useState({
    recoveryAction: "",
    evidenceRefs: "",
    requestedBy: "operator",
  });
  const [resumableForm, setResumableForm] = useState({
    specialistAcknowledgedBy: "specialist",
    operatorReviewedBy: "operator",
    evidenceRefs: "",
  });
  const [publishApprovalForm, setPublishApprovalForm] = useState({
    approvedByUserId: "operator",
  });

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.blogRuns.detail(runId!),
    queryFn: () => blogRunsApi.get(runId!),
    enabled: !!runId,
  });
  const { data: linkedIssue } = useQuery({
    queryKey: queryKeys.issues.detail(data?.run.issueId ?? "__none__"),
    queryFn: () => issuesApi.get(data!.run.issueId!),
    enabled: Boolean(data?.run.issueId),
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: "Dashboard", href: "/dashboard" },
      { label: "Blog run" },
    ]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    if (!data) return;
    setBreadcrumbs([
      { label: "Dashboard", href: "/dashboard" },
      { label: "Blog run" },
      { label: data.run.topic.length > 48 ? `${data.run.topic.slice(0, 48)}...` : data.run.topic },
    ]);
  }, [data, setBreadcrumbs]);

  const latestAttempt = useMemo(() => data?.attempts[data.attempts.length - 1] ?? null, [data]);
  const latestPublishAttempt = useMemo(
    () => [...(data?.attempts ?? [])].reverse().find((attempt) => attempt.stepKey === "publish") ?? null,
    [data],
  );
  const latestVerifyAttempt = useMemo(
    () => [...(data?.attempts ?? [])].reverse().find((attempt) => attempt.stepKey === "public_verify") ?? null,
    [data],
  );
  const publishResult = useMemo(() => asRecord(latestPublishAttempt?.resultJson), [latestPublishAttempt]);
  const verifyResult = useMemo(() => asRecord(latestVerifyAttempt?.resultJson), [latestVerifyAttempt]);
  const publishArtifacts = useMemo(
    () => (data?.artifacts ?? []).filter((artifact) => artifact.stepKey === "publish"),
    [data],
  );
  const verifyArtifacts = useMemo(
    () => (data?.artifacts ?? []).filter((artifact) => artifact.stepKey === "public_verify"),
    [data],
  );
  const resumeRequirements = useMemo(() => {
    const raw = data?.stopReason?.resumeRequirements;
    return Array.isArray(raw) ? raw.map((entry) => String(entry ?? "").trim()).filter(Boolean) : [];
  }, [data]);

  const invalidateRun = async () => {
    if (!runId) return;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.blogRuns.detail(runId) }),
      queryClient.invalidateQueries({
        predicate: (query) => Array.isArray(query.queryKey) && query.queryKey[0] === "blog-runs",
      }),
    ]);
  };

  const requestResumeReview = useMutation({
    mutationFn: async () => {
      if (!runId) return;
      const evidenceRefs = resumeReviewForm.evidenceRefs.split(/\n|,/g).map((entry) => entry.trim()).filter(Boolean);
      return blogRunsApi.requestResumeReview(runId, {
        recoveryAction: resumeReviewForm.recoveryAction.trim(),
        requestedBy: resumeReviewForm.requestedBy.trim(),
        evidenceRefs,
      });
    },
    onSuccess: async () => {
      await invalidateRun();
      pushToast({ title: "Resume review requested", tone: "success" });
    },
    onError: (error) => {
      pushToast({ title: error instanceof Error ? error.message : "Failed to request resume review", tone: "error" });
    },
  });

  const markResumable = useMutation({
    mutationFn: async () => {
      if (!runId) return;
      const evidenceRefs = resumableForm.evidenceRefs.split(/\n|,/g).map((entry) => entry.trim()).filter(Boolean);
      return blogRunsApi.markResumable(runId, {
        specialistAcknowledgedBy: resumableForm.specialistAcknowledgedBy.trim(),
        operatorReviewedBy: resumableForm.operatorReviewedBy.trim(),
        evidenceRefs,
        confirmedRequirements: resumeRequirements,
      });
    },
    onSuccess: async () => {
      await invalidateRun();
      pushToast({ title: "Run marked resumable", tone: "success" });
    },
    onError: (error) => {
      pushToast({ title: error instanceof Error ? error.message : "Failed to mark resumable", tone: "error" });
    },
  });

  const requestPublishApproval = useMutation({
    mutationFn: async () => {
      if (!runId) return;
      return blogRunsApi.requestPublishApprovalFromRun(runId, {
        approvedByUserId: publishApprovalForm.approvedByUserId.trim() || undefined,
      });
    },
    onSuccess: async () => {
      await invalidateRun();
      pushToast({ title: "Publish approval created", tone: "success" });
    },
    onError: (error) => {
      pushToast({ title: error instanceof Error ? error.message : "Failed to create publish approval", tone: "error" });
    },
  });

  const runNext = useMutation({
    mutationFn: async () => {
      if (!runId) return;
      return blogRunsApi.runNext(runId);
    },
    onSuccess: async () => {
      await invalidateRun();
      pushToast({ title: "Run step started", tone: "success" });
    },
    onError: (error) => {
      pushToast({ title: error instanceof Error ? error.message : "Failed to start next step", tone: "error" });
    },
  });

  if (isLoading) {
    return <div className="text-sm text-muted-foreground">Loading blog run...</div>;
  }

  if (error || !data) {
    return <div className="text-sm text-destructive">{error instanceof Error ? error.message : "Blog run not found"}</div>;
  }

  const state = summarizeState(data.run);
  const blocker = blockerText(data);
  const approvalState = deriveApprovalState(data);
  const publishState = derivePublishState(data);
  const verifyState = deriveVerifyState(data);

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-border bg-background/70 p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.18em]", toneClass(state.tone))}>
                {state.label}
              </span>
              <span className="text-xs text-muted-foreground">
                Updated {relativeTime(data.run.updatedAt)}
              </span>
            </div>
            <h1 className="mt-3 text-xl font-semibold tracking-tight text-foreground">
              {data.run.topic}
            </h1>
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span>{data.run.lane}</span>
              <span>{data.run.publishMode}</span>
              <span>{data.run.targetSite}</span>
              {data.run.issueId ? <Link to={`/issues/${data.run.issueId}`} className="underline underline-offset-2">linked issue</Link> : null}
              {linkedIssue?.originKind === "routine_execution" && linkedIssue.originId ? (
                <Link to={`/routines/${linkedIssue.originId}`} className="underline underline-offset-2">
                  parent routine
                </Link>
              ) : null}
            </div>
          </div>
          {data.run.publishedUrl ? (
            <a
              href={data.run.publishedUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-background/70 px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            >
              <ExternalLink className="h-3 w-3" />
              Open page
            </a>
          ) : null}
        </div>
        <div className="mt-4 flex flex-wrap gap-1.5">
          {summaryChip("approval", approvalState)}
          {summaryChip("publish", publishState)}
          {summaryChip("verify", verifyState)}
          {data.run.currentStep ? summaryChip("step", data.run.currentStep) : null}
        </div>
        {blocker ? (
          <p className="mt-4 text-sm text-muted-foreground">{blocker}</p>
        ) : null}
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.3fr_0.7fr]">
        <div className="rounded-xl border border-border bg-background/70 p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Step attempts</h2>
          <div className="mt-4 space-y-3">
            {data.attempts.length === 0 ? (
              <p className="text-sm text-muted-foreground">No attempts yet.</p>
            ) : data.attempts.map((attempt) => (
              <div key={attempt.id} className="rounded-lg border border-border/70 p-3">
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  {summaryChip("step", attempt.stepKey)}
                  {summaryChip("status", attempt.status)}
                  <span>attempt {attempt.attemptNumber}</span>
                  <span>{relativeTime(attempt.updatedAt)}</span>
                </div>
                {attempt.errorMessage ? (
                  <p className="mt-2 text-sm text-muted-foreground">{attempt.errorMessage}</p>
                ) : null}
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-6">
          <div className="rounded-xl border border-border bg-background/70 p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Publish evidence</h2>
            <div className="mt-4 space-y-3">
              {publishResult ? (
                <div className="rounded-lg border border-border/70 p-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    {summaryChip("mode", String(publishResult.mode ?? "unknown"))}
                    {publishResult.postId || publishResult.post_id ? summaryChip("post", String(publishResult.postId ?? publishResult.post_id)) : null}
                    {publishResult.status ? summaryChip("status", String(publishResult.status)) : null}
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {String(publishResult.url ?? data.run.publishedUrl ?? "").trim() || "No published URL recorded."}
                  </p>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No publish receipt yet.</p>
              )}
              {publishArtifacts.length > 0 ? publishArtifacts.map((artifact) => (
                <div key={artifact.id} className="rounded-lg border border-border/70 p-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    {summaryChip("kind", artifact.artifactKind)}
                  </div>
                  {artifact.storagePath ? (
                    <p className="mt-2 break-all text-sm text-muted-foreground">{artifact.storagePath}</p>
                  ) : artifact.bodyPreview ? (
                    <p className="mt-2 text-sm text-muted-foreground">{artifact.bodyPreview}</p>
                  ) : null}
                </div>
              )) : null}
            </div>
          </div>

          <div className="rounded-xl border border-border bg-background/70 p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Public verify evidence</h2>
            <div className="mt-4 space-y-3">
              {verifyResult ? (
                <div className="rounded-lg border border-border/70 p-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    {verifyResult.verdict ? summaryChip("verdict", String(verifyResult.verdict)) : null}
                    {verifyResult.readerDecisionState ? summaryChip("reader", String(verifyResult.readerDecisionState)) : null}
                    {verifyResult.schemaVersion ? summaryChip("schema", String(verifyResult.schemaVersion)) : null}
                  </div>
                  {Array.isArray(verifyResult.failureNames) && verifyResult.failureNames.length > 0 ? (
                    <p className="mt-2 text-sm text-muted-foreground">
                      Failures: {verifyResult.failureNames.map((entry) => String(entry)).join(", ")}
                    </p>
                  ) : null}
                  {asRecord(verifyResult.publicObservation)?.summary ? (
                    <p className="mt-2 text-sm text-muted-foreground">
                      {String(asRecord(verifyResult.publicObservation)?.summary ?? "")}
                    </p>
                  ) : null}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No public verify result yet.</p>
              )}
              {verifyArtifacts.length > 0 ? verifyArtifacts.map((artifact) => (
                <div key={artifact.id} className="rounded-lg border border-border/70 p-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    {summaryChip("kind", artifact.artifactKind)}
                  </div>
                  {artifact.storagePath ? (
                    <p className="mt-2 break-all text-sm text-muted-foreground">{artifact.storagePath}</p>
                  ) : artifact.bodyPreview ? (
                    <p className="mt-2 text-sm text-muted-foreground">{artifact.bodyPreview}</p>
                  ) : null}
                </div>
              )) : null}
            </div>
          </div>

          <div className="rounded-xl border border-border bg-background/70 p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Approvals</h2>
            <div className="mt-4 space-y-3">
              {data.approvals.length === 0 ? (
                <p className="text-sm text-muted-foreground">No approvals yet.</p>
              ) : data.approvals.map((approval) => (
                <div key={approval.id} className="rounded-lg border border-border/70 p-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    {summaryChip("site", approval.siteId)}
                    {summaryChip("slug", approval.targetSlug)}
                    <span>{relativeTime(approval.approvedAt)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-border bg-background/70 p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Artifacts</h2>
            <div className="mt-4 space-y-3">
              {data.artifacts.length === 0 ? (
                <p className="text-sm text-muted-foreground">No artifacts yet.</p>
              ) : data.artifacts.map((artifact) => (
                <div key={artifact.id} className="rounded-lg border border-border/70 p-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    {summaryChip("kind", artifact.artifactKind)}
                    {summaryChip("step", artifact.stepKey)}
                  </div>
                  {artifact.storagePath ? (
                    <p className="mt-2 break-all text-sm text-muted-foreground">{artifact.storagePath}</p>
                  ) : artifact.bodyPreview ? (
                    <p className="mt-2 line-clamp-3 text-sm text-muted-foreground">{artifact.bodyPreview}</p>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {latestAttempt?.resultJson ? (
        <div className="rounded-xl border border-border bg-background/70 p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Latest result payload</h2>
          <pre className="mt-4 overflow-x-auto rounded-lg border border-border/70 bg-muted/20 p-3 text-xs text-muted-foreground">
            {JSON.stringify(latestAttempt.resultJson, null, 2)}
          </pre>
        </div>
      ) : null}

      {(data.run.status === "failed" || data.run.status === "review_required" || data.run.status === "publish_approval_pending" || data.run.status === "publish_approved" || data.run.status === "published" || data.run.status === "resumable") ? (
        <div className="rounded-xl border border-border bg-background/70 p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Operator actions</h2>
          {data.run.status === "publish_approved" || data.run.status === "published" || data.run.status === "resumable" ? (
            <div className="mt-4 space-y-3">
              <p className="text-sm text-muted-foreground">
                Continue this run through the next execution step using the existing Paperclip run worker.
              </p>
              <Button onClick={() => runNext.mutate()} disabled={runNext.isPending}>
                {data.run.status === "publish_approved"
                  ? "Run publish now"
                  : data.run.status === "published"
                    ? "Run public verify now"
                    : "Resume run"}
              </Button>
            </div>
          ) : null}
          {data.run.status === "publish_approval_pending" ? (
            <div className="mt-4 space-y-3">
              <p className="text-sm text-muted-foreground">
                Create the publish approval from the current run package. Approval seed fields are derived from the run context.
              </p>
              <input
                value={publishApprovalForm.approvedByUserId}
                onChange={(event) => setPublishApprovalForm({ approvedByUserId: event.target.value })}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                placeholder="approved by user id"
              />
              <Button
                onClick={() => requestPublishApproval.mutate()}
                disabled={requestPublishApproval.isPending}
              >
                Create publish approval
              </Button>
            </div>
          ) : null}
          {data.run.status === "failed" ? (
            <div className="mt-4 space-y-3">
              <p className="text-sm text-muted-foreground">
                Request a resume review for this stopped run.
              </p>
              <input
                value={resumeReviewForm.requestedBy}
                onChange={(event) => setResumeReviewForm((prev) => ({ ...prev, requestedBy: event.target.value }))}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                placeholder="requested by"
              />
              <input
                value={resumeReviewForm.recoveryAction}
                onChange={(event) => setResumeReviewForm((prev) => ({ ...prev, recoveryAction: event.target.value }))}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                placeholder="recovery action"
              />
              <textarea
                value={resumeReviewForm.evidenceRefs}
                onChange={(event) => setResumeReviewForm((prev) => ({ ...prev, evidenceRefs: event.target.value }))}
                className="min-h-24 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                placeholder="evidence refs, one per line"
              />
              <Button
                onClick={() => requestResumeReview.mutate()}
                disabled={requestResumeReview.isPending || !resumeReviewForm.requestedBy.trim() || !resumeReviewForm.recoveryAction.trim() || !resumeReviewForm.evidenceRefs.trim()}
              >
                Request resume review
              </Button>
            </div>
          ) : null}
          {data.run.status === "review_required" ? (
            <div className="mt-4 space-y-3">
              <p className="text-sm text-muted-foreground">
                Confirm the recovery requirements and reopen this run for execution.
              </p>
              {resumeRequirements.length > 0 ? (
                <div className="rounded-lg border border-border/70 bg-muted/20 p-3">
                  <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Resume requirements</p>
                  <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
                    {resumeRequirements.map((item) => (
                      <li key={item}>- {item}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <input
                value={resumableForm.specialistAcknowledgedBy}
                onChange={(event) => setResumableForm((prev) => ({ ...prev, specialistAcknowledgedBy: event.target.value }))}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                placeholder="specialist acknowledged by"
              />
              <input
                value={resumableForm.operatorReviewedBy}
                onChange={(event) => setResumableForm((prev) => ({ ...prev, operatorReviewedBy: event.target.value }))}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                placeholder="operator reviewed by"
              />
              <textarea
                value={resumableForm.evidenceRefs}
                onChange={(event) => setResumableForm((prev) => ({ ...prev, evidenceRefs: event.target.value }))}
                className="min-h-24 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                placeholder="evidence refs, one per line"
              />
              <Button
                onClick={() => markResumable.mutate()}
                disabled={markResumable.isPending || !resumableForm.specialistAcknowledgedBy.trim() || !resumableForm.operatorReviewedBy.trim() || !resumableForm.evidenceRefs.trim()}
              >
                Mark resumable
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
