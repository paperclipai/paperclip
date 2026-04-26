import { useEffect, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { Agent, Approval } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { MessageSquare } from "lucide-react";
import { assetsApi } from "../api/assets";
import { useCompany } from "../context/CompanyContext";
import { Identity } from "./Identity";
import { CeoStrategyPayload, approvalLabel, resolveCeoPrimaryText } from "./ApprovalPayload";
import { cn } from "../lib/utils";

interface ExpandableApprovalCardProps {
  approval: Approval;
  requesterAgent: Agent | null;
  expanded: boolean;
  onToggle: () => void;
  onApprove: () => void;
  onReject: () => void;
  onRequestRevision: (note?: string) => void;
  onSubmitRevision: (contentPayload: Record<string, unknown>) => void;
  isPending: boolean;
  needsReminder?: boolean;
  ageHours?: number | null;
  muted?: boolean;
  dismissing?: boolean;
  detailLink: string;
}

function statusDot(approval: Approval, needsReminder: boolean) {
  if (approval.status === "pending" || approval.status === "revision_requested") {
    return needsReminder ? "bg-rose-500" : "bg-yellow-500";
  }
  return "bg-muted-foreground/40";
}

function channelLabel(payload: Record<string, unknown> | null | undefined): string {
  if (!payload) return "—";
  const channel = typeof payload.channel === "string" ? payload.channel : null;
  const category = typeof payload.category === "string" ? payload.category : null;
  return channel ?? category ?? "—";
}

function payloadDate(payload: Record<string, unknown> | null | undefined, keys: string[]): string | null {
  if (!payload) return null;
  for (const key of keys) {
    const raw = payload[key];
    if (typeof raw === "string" && raw.trim()) return raw.trim();
  }
  return null;
}

function payloadText(payload: Record<string, unknown> | null | undefined, keys: string[]): string | null {
  if (!payload) return null;
  for (const key of keys) {
    const raw = payload[key];
    if (typeof raw === "string" && raw.trim()) return raw.trim();
  }
  return null;
}

export function ExpandableApprovalCard({
  approval,
  requesterAgent,
  expanded,
  onToggle,
  onApprove,
  onReject,
  onRequestRevision,
  onSubmitRevision,
  isPending,
  needsReminder = false,
  ageHours = null,
  muted = false,
  dismissing = false,
  detailLink,
}: ExpandableApprovalCardProps) {
  const payload = (approval.payload ?? null) as Record<string, unknown> | null;
  const { selectedCompanyId } = useCompany();

  const approvedAt = approval.decidedAt ? String(approval.decidedAt) : null;
  const pickedUpAt = payloadDate(payload, ["consumedAt", "claimedAt", "pickedUpAt", "katyaClaimedAt"]);
  const scheduledFor = payloadDate(payload, ["targetPublishAt", "scheduledAt", "scheduledFor", "publishAt"]);
  const publishedAt = payloadDate(payload, ["publishedAt", "postedAt"]);
  const proofUrl = payloadText(payload, ["proofUrl", "publishedUrl", "postUrl", "url"]);
  const liveState = approval.status === "published"
    ? "Published"
    : pickedUpAt
      ? "Picked up by Katya"
      : approval.status === "scheduled"
        ? "Queued for publish"
        : approval.status === "approved"
          ? "Approved, awaiting pickup"
          : approval.status === "revision_requested"
            ? "Needs edits"
            : approval.status === "rejected"
              ? "Rejected"
              : "Pending review";

  const label = useMemo(() => approvalLabel(approval.type, payload), [approval.type, payload]);
  const title = useMemo(() => {
    const payloadTitle = payload && typeof payload.title === "string" ? payload.title.trim() : "";
    return payloadTitle.length > 0 ? payloadTitle : label;
  }, [payload, label]);
  const isActionable = approval.status === "pending" || approval.status === "revision_requested";
  const resolvedDraftText = useMemo(() => resolveCeoPrimaryText(payload ?? {}), [payload]);
  const [editorText, setEditorText] = useState(resolvedDraftText ?? "");
  const [imageUrl, setImageUrl] = useState("");
  const [imagePath, setImagePath] = useState("");
  const [uploadError, setUploadError] = useState<string | null>(null);

  const uploadImage = useMutation({
    mutationFn: async (file: File) => {
      if (!selectedCompanyId) throw new Error("Select a company before uploading an image");
      return assetsApi.uploadImage(selectedCompanyId, file, "approvals/revisions");
    },
    onSuccess: (asset) => {
      setUploadError(null);
      if (asset?.contentPath) {
        setImageUrl(asset.contentPath);
      } else if (asset?.assetId) {
        setImageUrl(`/api/assets/${asset.assetId}/content`);
      }
    },
    onError: (err) => {
      setUploadError(err instanceof Error ? err.message : "Image upload failed");
    },
  });

  useEffect(() => {
    setEditorText(resolvedDraftText ?? "");
    setImageUrl("");
    setImagePath("");
    setUploadError(null);
  }, [approval.id, resolvedDraftText]);

  return (
    <div
      className={cn(
        "rounded-md border border-border bg-card transition-all duration-200",
        muted && "opacity-60",
        dismissing && "opacity-0 translate-y-1",
        needsReminder && isActionable && "border-rose-300/60",
      )}
    >
      {needsReminder && isActionable && (
        <div className="border-b border-rose-300/50 bg-rose-500/10 px-3 py-1 text-[11px] text-rose-700 dark:text-rose-300">
          Pending {ageHours ?? 0}h
        </div>
      )}

      <button type="button" onClick={onToggle} className="w-full text-left px-3 py-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className={cn("inline-flex h-2 w-2 rounded-full", statusDot(approval, needsReminder))} />
              <p className="text-sm font-medium truncate">{title}</p>
              {(approval.commentCount ?? 0) > 0 && (
                <span className="inline-flex items-center gap-0.5 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground shrink-0">
                  <MessageSquare className="h-2.5 w-2.5" />
                  {approval.commentCount}
                </span>
              )}
            </div>
            <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
              <span className="truncate">{channelLabel(payload)}</span>
              <span>·</span>
              <span>{typeof ageHours === "number" ? `${ageHours}h` : "—"}</span>
              {requesterAgent && (
                <>
                  <span>·</span>
                  <Identity name={requesterAgent.name} size="sm" className="inline-flex" />
                </>
              )}
            </div>
          </div>
          <span className="text-muted-foreground text-xs shrink-0">{expanded ? "▴" : "▾"}</span>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-border px-3 py-3 space-y-3">
          <CeoStrategyPayload payload={payload ?? {}} />

          <div className="rounded-md border border-border bg-muted/20 px-2 py-2">
            <p className="text-[11px] font-medium text-muted-foreground mb-1">Execution status</p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-1 text-[11px]">
              <div><span className="text-muted-foreground">Live state:</span> <span>{liveState}</span></div>
              <div><span className="text-muted-foreground">Approved at:</span> <span>{approvedAt ?? "—"}</span></div>
              <div><span className="text-muted-foreground">Picked up by Katya:</span> <span>{pickedUpAt ?? "—"}</span></div>
              <div><span className="text-muted-foreground">Scheduled for:</span> <span>{scheduledFor ?? "—"}</span></div>
              <div><span className="text-muted-foreground">Published at:</span> <span>{publishedAt ?? "—"}</span></div>
              <div className="md:col-span-2 truncate">
                <span className="text-muted-foreground">Proof URL:</span> <span>{proofUrl ?? "—"}</span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 pt-1">
            <Button
              size="sm"
              className="bg-green-700 hover:bg-green-600 text-white"
              onClick={onApprove}
              disabled={isPending || !isActionable}
            >
              Approve
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={onReject}
              disabled={isPending || !isActionable}
            >
              Reject
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onRequestRevision()}
              disabled={isPending || !isActionable}
            >
              Request edits
            </Button>
          </div>

          <div className="border-t border-border pt-3 space-y-2">
            <p className="text-xs text-muted-foreground">Edit before approving</p>
            <textarea
              value={editorText}
              onChange={(e) => setEditorText(e.target.value)}
              className="w-full min-h-40 rounded-md border border-border bg-background px-2 py-1.5 text-xs"
            />

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
              <div className="space-y-1">
                <label className="text-[11px] text-muted-foreground">Image weblink (optional)</label>
                <input
                  value={imageUrl}
                  onChange={(e) => setImageUrl(e.target.value)}
                  placeholder="https://..."
                  className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[11px] text-muted-foreground">Image file path (optional)</label>
                <input
                  value={imagePath}
                  onChange={(e) => setImagePath(e.target.value)}
                  placeholder="/path/to/image.jpg or repo-relative path"
                  className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[11px] text-muted-foreground">Upload image file (optional)</label>
                <input
                  type="file"
                  accept="image/*"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    setUploadError(null);
                    uploadImage.mutate(file);
                    e.currentTarget.value = "";
                  }}
                  className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs file:mr-2 file:rounded file:border-0 file:bg-muted file:px-2 file:py-1 file:text-xs"
                  disabled={uploadImage.isPending || !isActionable || isPending}
                />
                {uploadImage.isPending && <p className="text-[11px] text-muted-foreground">Uploading image…</p>}
                {uploadError && <p className="text-[11px] text-destructive">{uploadError}</p>}
              </div>
            </div>

            <div className="flex items-center justify-between">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const contentPayload: Record<string, unknown> = { draft: editorText.trim() };
                  if (imageUrl.trim()) contentPayload.mediaUrl = imageUrl.trim();
                  if (imagePath.trim()) contentPayload.mediaPath = imagePath.trim();
                  onSubmitRevision(contentPayload);
                }}
                disabled={isPending || !isActionable}
              >
                Submit revision
              </Button>
              <Link to={detailLink} className="text-xs text-muted-foreground hover:text-foreground no-underline">
                Full draft ↗️
              </Link>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
