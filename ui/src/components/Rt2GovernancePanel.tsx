import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { rt2GovernanceApi } from "../api/rt2-governance";
import { rt2JarvisRuntimeApi } from "../api/rt2-jarvis-runtime";
import type {
  Rt2Approval,
  Rt2ApprovalWithComments,
  Rt2GovernanceStatus,
  Rt2ActivityLogEntry,
  Rt2ApprovalType,
  Rt2ApprovalStatus,
} from "@paperclipai/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

function formatTimestamp(date: Date | string | null): string {
  if (!date) return "-";
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleDateString("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatHours(hours: number): string {
  if (hours < 1) return "<1h";
  if (hours >= 24) return `${Math.round(hours / 24)}d`;
  return `${Math.round(hours)}h`;
}

const TYPE_LABELS: Record<Rt2ApprovalType, string> = {
  hire_agent: "에이전트 고용",
  approve_strategy: "전략 승인",
  task_completion: "태스크 완료",
  deployment: "배포",
  budget_exceed: "예산 초과",
  jarvis_auto_action: "Jarvis Auto",
  jarvis_skill_capability: "Jarvis Skill",
};

const TYPE_COLORS: Record<Rt2ApprovalType, "default" | "secondary" | "outline" | "destructive"> = {
  hire_agent: "destructive",
  approve_strategy: "default",
  task_completion: "secondary",
  deployment: "outline",
  budget_exceed: "destructive",
  jarvis_auto_action: "destructive",
  jarvis_skill_capability: "secondary",
};

function ApprovalTypeBadge({ type }: { type: Rt2ApprovalType }) {
  return (
    <Badge variant={TYPE_COLORS[type]} className="text-xs">
      {TYPE_LABELS[type]}
    </Badge>
  );
}

function StatusBadge({ status }: { status: Rt2ApprovalStatus }) {
  return (
    <Badge
      variant={
        status === "approved" ? "default" : status === "rejected" ? "destructive" : "secondary"
      }
      className="text-xs"
    >
      {status === "pending" ? "대기중" : status === "approved" ? "승인" : "거절"}
    </Badge>
  );
}

function ActivityEntry({ entry }: { entry: Rt2ActivityLogEntry }) {
  const isToolCall = entry.entityType === "tool_call";

  return (
    <div
      className={`flex items-start justify-between gap-3 rounded-lg border px-3 py-2 text-sm ${
        isToolCall ? "border-amber-500/30 bg-amber-500/5" : "border-border"
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-muted-foreground">
            {entry.actorType === "user" ? "👤" : entry.actorType === "agent" ? "🤖" : "⚙️"}
          </span>
          <span className="font-medium">{entry.action}</span>
          {isToolCall && (
            <Badge variant="outline" className="text-xs bg-amber-500/10 text-amber-600 border-amber-500/30">
              Tool Call
            </Badge>
          )}
        </div>
        <div className="text-xs text-muted-foreground mt-0.5">
          {entry.entityType}:{entry.entityId}
        </div>
      </div>
      <div className="text-xs text-muted-foreground shrink-0">
        {formatTimestamp(entry.createdAt)}
      </div>
    </div>
  );
}

function CommentForm({
  approvalId,
  companyId,
  onSuccess,
}: {
  approvalId: string;
  companyId: string;
  onSuccess: () => void;
}) {
  const [body, setBody] = useState("");
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: () => rt2GovernanceApi.addComment(companyId, approvalId, body),
    onSuccess: () => {
      setBody("");
      queryClient.invalidateQueries({ queryKey: ["rt2-governance-approval", companyId, approvalId] });
      onSuccess();
    },
  });

  return (
    <div className="flex gap-2">
      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="코멘트를 입력하세요..."
        className="min-h-[60px] text-sm"
        rows={2}
      />
      <Button
        size="sm"
        onClick={() => mutation.mutate()}
        disabled={!body.trim() || mutation.isPending}
        className="shrink-0"
      >
        등록
      </Button>
    </div>
  );
}

function ApprovalCard({
  approval,
  companyId,
}: {
  approval: Rt2Approval;
  companyId: string;
}) {
  const queryClient = useQueryClient();
  const [showComments, setShowComments] = useState(false);
  const [commentText, setCommentText] = useState("");

  const { data: fullApproval, isLoading } = useQuery({
    queryKey: ["rt2-governance-approval", companyId, approval.id],
    queryFn: () => rt2GovernanceApi.getApproval(companyId, approval.id),
    enabled: showComments,
  });

  const approveMutation = useMutation({
    mutationFn: (note?: string) => rt2GovernanceApi.approveApproval(companyId, approval.id, note),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["rt2-governance-queue", companyId] });
      queryClient.invalidateQueries({ queryKey: ["rt2-governance-status", companyId] });
    },
  });

  const rejectMutation = useMutation({
    mutationFn: (note?: string) => rt2GovernanceApi.rejectApproval(companyId, approval.id, note ?? undefined),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["rt2-governance-queue", companyId] });
      queryClient.invalidateQueries({ queryKey: ["rt2-governance-status", companyId] });
    },
  });

  const addCommentMutation = useMutation({
    mutationFn: () =>
      rt2GovernanceApi.addComment(
        companyId,
        approval.id,
        commentText,
      ),
    onSuccess: () => {
      setCommentText("");
      queryClient.invalidateQueries({
        queryKey: ["rt2-governance-approval", companyId, approval.id],
      });
    },
  });

  const isPending = approval.status === "pending";

  return (
    <div className="rounded-xl border border-border bg-background p-4 space-y-3">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <ApprovalTypeBadge type={approval.type} />
            <StatusBadge status={approval.status} />
          </div>
          <p className="text-sm font-medium mt-1 truncate">
            {String(approval.payload?.title || approval.payload?.name || approval.type)}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            요청: {approval.requestedByUserId || approval.requestedByAgentId || "알 수 없음"}
          </p>
          <p className="text-xs text-muted-foreground">
            {formatTimestamp(approval.createdAt)}
          </p>
        </div>
      </div>

      {/* Decision note */}
      {approval.decisionNote && (
        <div className="rounded-md bg-muted/50 px-3 py-2 text-sm">
          <span className="text-xs text-muted-foreground">결정 코멘트: </span>
          <span>{approval.decisionNote}</span>
        </div>
      )}

      {/* Actions */}
      {isPending && (
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="default"
            className="bg-green-600 hover:bg-green-700"
            onClick={() => approveMutation.mutate(undefined)}
            disabled={approveMutation.isPending}
          >
            {approveMutation.isPending ? "승인 중..." : "✅ 승인"}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => rejectMutation.mutate(undefined)}
            disabled={rejectMutation.isPending}
          >
            {rejectMutation.isPending ? "거절 중..." : "❌ 거절"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowComments(!showComments)}
          >
            💬 코멘트
          </Button>
        </div>
      )}

      {/* Comments section */}
      {showComments && (
        <div className="space-y-3 pt-2 border-t">
          <CommentForm
            approvalId={approval.id}
            companyId={companyId}
            onSuccess={() => {}}
          />

          {isLoading ? (
            <p className="text-sm text-muted-foreground">로딩 중...</p>
          ) : fullApproval && fullApproval.comments.length > 0 ? (
            <div className="space-y-2">
              {fullApproval.comments.map((comment) => (
                <div key={comment.id} className="rounded-md bg-muted/30 px-3 py-2">
                  <div className="text-sm">{comment.body}</div>
                  <div className="text-xs text-muted-foreground mt-1">
                    {comment.authorUserId || comment.authorAgentId || "알 수 없음"} ·{" "}
                    {formatTimestamp(comment.createdAt)}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">코멘트가 없습니다.</p>
          )}
        </div>
      )}
    </div>
  );
}

function GovernanceDashboard({
  status,
  companyId,
}: {
  status: Rt2GovernanceStatus;
  companyId: string;
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="rounded-lg border border-border px-3 py-2">
        <div className="text-xs text-muted-foreground">대기중</div>
        <div className="text-2xl font-bold">{status.pendingApprovals}</div>
      </div>
      <div className="rounded-lg border border-green-500/30 bg-green-500/5 px-3 py-2">
        <div className="text-xs text-muted-foreground">이번주 승인</div>
        <div className="text-2xl font-bold text-green-600">{status.approvedThisWeek}</div>
      </div>
      <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2">
        <div className="text-xs text-muted-foreground">이번주 거절</div>
        <div className="text-2xl font-bold text-red-600">{status.rejectedThisWeek}</div>
      </div>
      <div className="rounded-lg border border-border px-3 py-2">
        <div className="text-xs text-muted-foreground">평균 승인시간</div>
        <div className="text-2xl font-bold">{formatHours(status.averageApprovalTimeHours)}</div>
      </div>
    </div>
  );
}

function ActivityLogSection({ companyId }: { companyId: string }) {
  const [filter, setFilter] = useState<"all" | "tool_call">("all");

  const { data: entries, isLoading } = useQuery({
    queryKey: ["rt2-governance-activity-log", companyId],
    queryFn: () =>
      rt2GovernanceApi.getActivityLog(companyId, {
        ...(filter === "tool_call" ? { entityType: "tool_call" } : {}),
        limit: 50,
      }),
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium">활동 로그</h4>
        <div className="flex gap-1">
          <Button
            size="sm"
            variant={filter === "all" ? "default" : "outline"}
            onClick={() => setFilter("all")}
          >
            전체
          </Button>
          <Button
            size="sm"
            variant={filter === "tool_call" ? "default" : "outline"}
            onClick={() => setFilter("tool_call")}
          >
            Tool Calls
          </Button>
        </div>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">로딩 중...</p>
      ) : entries && entries.length > 0 ? (
        <div className="space-y-2 max-h-[300px] overflow-y-auto">
          {entries.map((entry) => (
            <ActivityEntry key={entry.id} entry={entry} />
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">활동 로그가 없습니다.</p>
      )}
    </div>
  );
}

function JarvisRuntimeSection({ companyId }: { companyId: string }) {
  const { data: capabilities, isLoading } = useQuery({
    queryKey: ["rt2-jarvis-skill-capabilities", companyId],
    queryFn: () => rt2JarvisRuntimeApi.listSkillCapabilities(companyId),
    enabled: Boolean(companyId),
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium">Jarvis Capability</h4>
        <Badge variant="outline" className="text-xs">governed runtime skills</Badge>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">로딩 중...</p>
      ) : capabilities && capabilities.length > 0 ? (
        <div className="space-y-2 max-h-[300px] overflow-y-auto">
          {capabilities.map((capability) => (
            <div key={capability.injectionId} className="rounded-lg border border-border px-3 py-2 text-sm">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate font-medium">{capability.skillKey}</div>
                  <div className="text-xs text-muted-foreground">
                    {capability.injectionType} · usage {capability.usageCount} · score {capability.effectivenessScore}
                  </div>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Badge variant={capability.status === "active" ? "default" : "secondary"} className="text-xs">
                    {capability.status}
                  </Badge>
                  {capability.approvalStatus && (
                    <Badge variant={capability.approvalStatus === "approved" ? "default" : capability.approvalStatus === "rejected" ? "destructive" : "outline"} className="text-xs">
                      {capability.approvalStatus}
                    </Badge>
                  )}
                </div>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{capability.policy.reason}</p>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">등록된 Jarvis runtime skill capability가 없습니다.</p>
      )}
    </div>
  );
}

type Tab = "approvals" | "activity" | "runtime";

export function Rt2GovernancePanel({ companyId }: { companyId: string }) {
  const [activeTab, setActiveTab] = useState<Tab>("approvals");

  const { data: status, isLoading: statusLoading } = useQuery({
    queryKey: ["rt2-governance-status", companyId],
    queryFn: () => rt2GovernanceApi.getStatus(companyId),
    enabled: Boolean(companyId),
  });

  const { data: queue, isLoading: queueLoading } = useQuery({
    queryKey: ["rt2-governance-queue", companyId],
    queryFn: () => rt2GovernanceApi.getApprovalQueue(companyId),
    enabled: Boolean(companyId),
  });

  const pendingCount = status?.pendingApprovals ?? 0;
  const hasPending = pendingCount > 0;

  return (
    <div className="space-y-4 rounded-xl border border-border bg-card p-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">거버넌스</h3>
          <Badge variant={hasPending ? "destructive" : "secondary"}>
            {pendingCount} 대기
          </Badge>
        </div>
      </div>

      {/* Dashboard Stats */}
      {statusLoading ? (
        <div className="flex justify-center py-4">
          <span className="text-sm text-muted-foreground">로딩 중...</span>
        </div>
      ) : status ? (
        <GovernanceDashboard status={status} companyId={companyId} />
      ) : null}

      {/* Tabs */}
      <div className="flex border-b">
        <button
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
            activeTab === "approvals"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => setActiveTab("approvals")}
        >
          승인 대기열
        </button>
        <button
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
            activeTab === "activity"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => setActiveTab("activity")}
        >
          활동 로그
        </button>
        <button
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
            activeTab === "runtime"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => setActiveTab("runtime")}
        >
          Jarvis 런타임
        </button>
      </div>

      {/* Tab Content */}
      {activeTab === "approvals" && (
        <div className="space-y-3">
          {queueLoading ? (
            <p className="text-sm text-muted-foreground text-center py-4">로딩 중...</p>
          ) : queue && queue.length > 0 ? (
            queue.map((approval) => (
              <ApprovalCard
                key={approval.id}
                approval={approval}
                companyId={companyId}
              />
            ))
          ) : (
            <p className="text-sm text-muted-foreground text-center py-4">
              대기중인 승인 요청이 없습니다.
            </p>
          )}
        </div>
      )}

      {activeTab === "activity" && <ActivityLogSection companyId={companyId} />}
      {activeTab === "runtime" && <JarvisRuntimeSection companyId={companyId} />}
    </div>
  );
}
