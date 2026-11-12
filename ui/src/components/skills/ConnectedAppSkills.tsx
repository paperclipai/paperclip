import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CompanyMcpSkill } from "@paperclipai/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { mcpSkillsApi } from "../../api/mcpSkills";
import { useToastActions } from "../../context/ToastContext";
import { formatBytes } from "../../lib/issue-output";
import { queryKeys } from "../../lib/queryKeys";
import { describeError } from "@/api/errors";

const STATUS_LABEL: Record<CompanyMcpSkill["status"], string> = {
  pending_review: "Needs review",
  approved: "Approved",
  declined: "Declined",
  unavailable: "Not available",
};

/** Plain-language reason for a skill's state, or null when the status says enough. */
export function connectedAppSkillNote(skill: CompanyMcpSkill): string | null {
  switch (skill.statusReason) {
    case "changed":
      return `${skill.appName} changed this skill. Agents won't use it until you approve the new version.`;
    case "dynamic":
      return "This skill is generated each time it's used, so Paperclip can't check its content. It isn't offered to agents.";
    case "too_large":
      return "This skill is bigger than apps can rely on (512 files or 16 MiB), so it isn't offered to agents.";
    case "invalid":
      return "This skill's listing doesn't follow the MCP skills format, so it isn't offered to agents.";
    case "verification_failed":
      return `${skill.appName} sent files that didn't match what it listed, so Paperclip stopped using this skill. Refresh the app to see its current version.`;
    case "removed":
      return `${skill.appName} no longer offers this skill.`;
    default:
      return null;
  }
}

export interface ConnectedAppSkillsListProps {
  skills: CompanyMcpSkill[];
  pendingSkillId?: string | null;
  /** `manifestDigest` is the version the shown text was verified against. */
  preview?: { skillId: string; manifestDigest?: string; markdown?: string; loading?: boolean; error?: string } | null;
  onPreview?: (skill: CompanyMcpSkill) => void;
  onApprove?: (skill: CompanyMcpSkill, allowTools: boolean) => void;
  onDecline?: (skill: CompanyMcpSkill) => void;
}

/** The connected-app skills section: review state and actions for each skill. */
export function ConnectedAppSkillsList({ skills, pendingSkillId, preview, onPreview, onApprove, onDecline }: ConnectedAppSkillsListProps) {
  const [allowTools, setAllowTools] = useState<Record<string, boolean>>({});
  if (!skills.length) return null;
  const waiting = skills.filter((skill) => skill.status === "pending_review").length;
  return (
    <section aria-labelledby="connected-app-skills-heading" className="mx-4 mt-4 rounded-lg border border-border">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-4 py-3">
        <h2 id="connected-app-skills-heading" className="text-sm font-semibold">Skills from connected apps</h2>
        <p className="text-xs text-muted-foreground">
          {waiting ? `${waiting} waiting for review. ` : ""}Agents that use an app get its skills only after you approve them.
        </p>
      </div>
      <ul className="divide-y divide-border">
        {skills.map((skill) => {
          const note = connectedAppSkillNote(skill);
          const reviewable = skill.status === "pending_review" || skill.status === "declined";
          const busy = pendingSkillId === skill.id;
          const showing = preview?.skillId === skill.id;
          // Text for an older version is never shown as this one, and the
          // board cannot approve while it reads something else.
          const previewCurrent = !showing || (Boolean(preview?.markdown) && preview?.manifestDigest === skill.manifestDigest);
          return (
            <li key={skill.id} className="flex flex-col gap-2 px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{skill.name}</span>
                <span className="text-xs text-muted-foreground">from {skill.appName}</span>
                <Badge variant={skill.status === "pending_review" ? "default" : "outline"}>{STATUS_LABEL[skill.status]}</Badge>
              </div>
              <p className="line-clamp-2 text-sm text-muted-foreground">{skill.description}</p>
              {skill.fileCount !== null && skill.totalBytes !== null ? (
                <p className="text-xs text-muted-foreground">
                  {skill.fileCount === 1 ? "1 file" : `${skill.fileCount} files`} · {formatBytes(skill.totalBytes)}
                </p>
              ) : null}
              {note ? <p className="text-sm">{note}</p> : null}
              {skill.nameCollision ? (
                <p className="text-xs text-muted-foreground">
                  Another skill uses this name. Agents get this one under {skill.appName}'s name, so neither replaces the other.
                </p>
              ) : null}
              {skill.requestedTools.length ? (
                reviewable ? (
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={allowTools[skill.id] === true}
                      onCheckedChange={(checked) => setAllowTools((current) => ({ ...current, [skill.id]: checked === true }))}
                    />
                    Also let it use: {skill.requestedTools.join(", ")}
                  </label>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {skill.allowedToolsApproved ? "Can use" : "Asked to use, not allowed"}: {skill.requestedTools.join(", ")}
                  </p>
                )
              ) : null}
              {skill.status !== "unavailable" ? (
                <div className="flex flex-wrap items-center gap-2">
                  {onPreview ? (
                    <Button size="xs" variant="ghost" onClick={() => onPreview(skill)} aria-expanded={showing}>
                      {showing ? "Hide instructions" : "Read instructions"}
                    </Button>
                  ) : null}
                  {reviewable && onApprove ? (
                    <Button size="xs" disabled={busy || !previewCurrent} onClick={() => onApprove(skill, allowTools[skill.id] === true)}>Approve</Button>
                  ) : null}
                  {skill.status !== "declined" && onDecline ? (
                    <Button size="xs" variant="outline" disabled={busy} onClick={() => onDecline(skill)}>
                      {skill.status === "approved" ? "Turn off" : "Decline"}
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {reviewable ? (
                <p className="text-xs text-muted-foreground">
                  Approving lets agents that use {skill.appName} follow these instructions, including commands they describe.
                </p>
              ) : null}
              {showing ? (
                preview?.error ? <p className="text-sm text-destructive">{preview.error}</p>
                  : preview?.loading || !previewCurrent ? <p className="text-sm text-muted-foreground">Loading instructions…</p>
                    // Shown as text: the content comes from the app and is never rendered as a page.
                    : <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 font-mono text-xs">{preview?.markdown}</pre>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Loads a company's connected-app skills and wires review actions. Renders nothing when there are none. */
export function ConnectedAppSkills({ companyId }: { companyId: string | null | undefined }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [previewId, setPreviewId] = useState<string | null>(null);
  const listQuery = useQuery({
    queryKey: queryKeys.mcpSkills.list(companyId ?? ""),
    queryFn: () => mcpSkillsApi.list(companyId!),
    enabled: Boolean(companyId),
  });
  const previewSkill = listQuery.data?.find((skill) => skill.id === previewId) ?? null;
  const contentQuery = useQuery({
    queryKey: queryKeys.mcpSkills.content(companyId ?? "", previewId ?? "", previewSkill?.manifestDigest ?? ""),
    queryFn: () => mcpSkillsApi.content(companyId!, previewId!),
    enabled: Boolean(companyId && previewSkill?.manifestDigest),
  });
  const reportError = (title: string) => (error: unknown) => {
    pushToast({ tone: "error", title, body: describeError(error).body });
    void queryClient.invalidateQueries({ queryKey: queryKeys.mcpSkills.list(companyId ?? "") });
  };
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.mcpSkills.list(companyId ?? "") });
  const approve = useMutation({
    mutationFn: ({ skill, allowTools }: { skill: CompanyMcpSkill; allowTools: boolean }) =>
      mcpSkillsApi.approve(companyId!, skill.id, { manifestDigest: skill.manifestDigest!, allowTools }),
    onSuccess: refresh,
    onError: reportError("Couldn't approve the skill"),
  });
  const decline = useMutation({
    mutationFn: (skill: CompanyMcpSkill) => mcpSkillsApi.decline(companyId!, skill.id),
    onSuccess: refresh,
    onError: reportError("Couldn't update the skill"),
  });
  if (listQuery.error) {
    return (
      <p role="alert" className="mx-4 mt-4 text-sm text-destructive">
        Couldn't load skills from connected apps. {describeError(listQuery.error).body}
      </p>
    );
  }
  const pendingSkillId = approve.isPending ? approve.variables?.skill.id : decline.isPending ? decline.variables?.id : null;
  return (
    <ConnectedAppSkillsList
      skills={listQuery.data ?? []}
      pendingSkillId={pendingSkillId ?? null}
      preview={previewId ? {
        skillId: previewId,
        manifestDigest: contentQuery.data?.manifestDigest,
        markdown: contentQuery.data?.markdown,
        loading: contentQuery.isLoading,
        error: contentQuery.error ? describeError(contentQuery.error).body : undefined,
      } : null}
      onPreview={(skill) => setPreviewId((current) => (current === skill.id ? null : skill.id))}
      onApprove={(skill, allowTools) => approve.mutate({ skill, allowTools })}
      onDecline={(skill) => decline.mutate(skill)}
    />
  );
}
