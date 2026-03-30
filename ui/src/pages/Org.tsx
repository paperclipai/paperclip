import { useEffect, useState } from "react";
import { Link } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { agentsApi, type OrgNode } from "../api/agents";
import { seatsApi } from "../api/seats";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { StatusBadge } from "../components/StatusBadge";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { ChevronRight, GitBranch, RefreshCcw, UserPlus, UserMinus } from "lucide-react";
import { cn } from "../lib/utils";
import { orgNodeBadges } from "../lib/org-node-display";
import { orgNodeCanManageSeat, primarySeatAction } from "../lib/seat-actions";
import { formatDelegatedPermissions, seatPermissionOptions } from "../lib/seat-permissions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

function OrgTree({
  nodes,
  depth = 0,
  hrefFn,
  onSelect,
  onAttach,
  onDetach,
  onEditPermissions,
  mutationPendingSeatId,
}: {
  nodes: OrgNode[];
  depth?: number;
  hrefFn: (id: string) => string;
  onSelect: (node: OrgNode) => void;
  onAttach: (node: OrgNode) => void;
  onDetach: (node: OrgNode) => void;
  onEditPermissions: (node: OrgNode) => void;
  mutationPendingSeatId: string | null;
}) {
  return (
    <div>
      {nodes.map((node) => (
        <OrgTreeNode
          key={node.id}
          node={node}
          depth={depth}
          hrefFn={hrefFn}
          onSelect={onSelect}
          onAttach={onAttach}
          onDetach={onDetach}
          onEditPermissions={onEditPermissions}
          mutationPendingSeatId={mutationPendingSeatId}
        />
      ))}
    </div>
  );
}

function OrgTreeNode({
  node,
  depth,
  hrefFn,
  onSelect,
  onAttach,
  onDetach,
  onEditPermissions,
  mutationPendingSeatId,
}: {
  node: OrgNode;
  depth: number;
  hrefFn: (id: string) => string;
  onSelect: (node: OrgNode) => void;
  onAttach: (node: OrgNode) => void;
  onDetach: (node: OrgNode) => void;
  onEditPermissions: (node: OrgNode) => void;
  mutationPendingSeatId: string | null;
}) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = node.reports.length > 0;
  const badges = orgNodeBadges(node);
  const action = primarySeatAction(node);
  const canManageSeat = orgNodeCanManageSeat(node);
  const actionPending = mutationPendingSeatId === node.seatId;

  return (
    <div>
      <Link
        to={hrefFn(node.id)}
        className="flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors cursor-pointer hover:bg-accent/50 no-underline text-inherit"
        style={{ paddingLeft: `${depth * 16 + 12}px` }}
      >
        {hasChildren ? (
          <button
            className="p-0.5"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setExpanded(!expanded);
            }}
          >
            <ChevronRight
              className={cn("h-3 w-3 transition-transform", expanded && "rotate-90")}
            />
          </button>
        ) : (
          <span className="w-4" />
        )}
        <span
          className={cn(
            "h-2 w-2 rounded-full shrink-0",
            node.status === "active"
              ? "bg-green-400"
              : node.status === "paused"
                ? "bg-yellow-400"
                : node.status === "pending_approval"
                  ? "bg-amber-400"
                : node.status === "error"
                  ? "bg-red-400"
                  : "bg-neutral-400"
          )}
        />
        <div className="flex-1 min-w-0">
          <div className="font-medium truncate">{node.name}</div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>{node.role}</span>
            {badges.map((badge) => (
              <span key={badge.key} className="rounded-full bg-accent px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
                {badge.label}
              </span>
            ))}
          </div>
        </div>
        {canManageSeat && (
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="rounded-md border border-border px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground hover:bg-accent"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onSelect(node);
              }}
            >
              Details
            </button>
            <button
              type="button"
              className="rounded-md border border-border px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground hover:bg-accent"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onEditPermissions(node);
              }}
            >
              Perms
            </button>
            {action && (
              <button
                type="button"
                className="rounded-md border border-border px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground hover:bg-accent"
                disabled={actionPending}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (action === "attach") {
                    onAttach(node);
                  } else {
                    onDetach(node);
                  }
                }}
              >
                {action === "attach" ? <UserPlus className="mr-1 inline h-3 w-3" /> : <UserMinus className="mr-1 inline h-3 w-3" />}
                {actionPending ? "Working" : action}
              </button>
            )}
          </div>
        )}
        <StatusBadge status={node.status} />
      </Link>
      {hasChildren && expanded && (
        <OrgTree
          nodes={node.reports}
          depth={depth + 1}
          hrefFn={hrefFn}
          onSelect={onSelect}
          onAttach={onAttach}
          onDetach={onDetach}
          onEditPermissions={onEditPermissions}
          mutationPendingSeatId={mutationPendingSeatId}
        />
      )}
    </div>
  );
}

export function Org() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [attachDialogNode, setAttachDialogNode] = useState<OrgNode | null>(null);
  const [selectedSeatNode, setSelectedSeatNode] = useState<OrgNode | null>(null);
  const [attachUserId, setAttachUserId] = useState("");
  const [permissionsDialogNode, setPermissionsDialogNode] = useState<OrgNode | null>(null);
  const [selectedPermissions, setSelectedPermissions] = useState<string[]>([]);
  const [mutationPendingSeatId, setMutationPendingSeatId] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Org Chart" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.org(selectedCompanyId!),
    queryFn: () => agentsApi.org(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: seatDetail } = useQuery({
    queryKey: permissionsDialogNode?.seatId ? queryKeys.seats.detail(selectedCompanyId!, permissionsDialogNode.seatId) : ["seats", "detail", "none"],
    queryFn: () => seatsApi.detail(selectedCompanyId!, permissionsDialogNode!.seatId!),
    enabled: !!selectedCompanyId && !!permissionsDialogNode?.seatId,
  });
  const { data: selectedSeatDetail } = useQuery({
    queryKey: selectedSeatNode?.seatId ? queryKeys.seats.detail(selectedCompanyId!, selectedSeatNode.seatId) : ["seats", "detail", "selected-none"],
    queryFn: () => seatsApi.detail(selectedCompanyId!, selectedSeatNode!.seatId!),
    enabled: !!selectedCompanyId && !!selectedSeatNode?.seatId,
  });

  const invalidateSeatViews = async () => {
    if (!selectedCompanyId) return;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.org(selectedCompanyId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(selectedCompanyId) }),
    ]);
  };

  const backfillSeats = useMutation({
    mutationFn: () => seatsApi.backfill(selectedCompanyId!),
    onSuccess: async (result) => {
      await invalidateSeatViews();
      pushToast({
        tone: "success",
        title: "Seat backfill complete",
        body: `${result.seatsCreated} seats created, ${result.ownershipBackfills.issues} issue owners backfilled.`,
      });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Seat backfill failed",
        body: error instanceof Error ? error.message : "Unknown error",
      });
    },
  });

  const reconcileModes = useMutation({
    mutationFn: () => seatsApi.reconcileModes(selectedCompanyId!),
    onSuccess: async (result) => {
      await invalidateSeatViews();
      pushToast({
        tone: "success",
        title: "Seat modes reconciled",
        body: `${result.updatedSeatCount} of ${result.scannedSeatCount} seats updated.`,
      });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Seat mode reconciliation failed",
        body: error instanceof Error ? error.message : "Unknown error",
      });
    },
  });

  const attachHuman = useMutation({
    mutationFn: async ({ seatId, userId }: { seatId: string; userId: string }) => {
      setMutationPendingSeatId(seatId);
      return seatsApi.attachHuman(selectedCompanyId!, seatId, userId);
    },
    onSuccess: async () => {
      await invalidateSeatViews();
      setAttachDialogNode(null);
      setAttachUserId("");
      pushToast({
        tone: "success",
        title: "Human attached to seat",
      });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Attach failed",
        body: error instanceof Error ? error.message : "Unknown error",
      });
    },
    onSettled: () => {
      setMutationPendingSeatId(null);
    },
  });

  const detachHuman = useMutation({
    mutationFn: async (seatId: string) => {
      setMutationPendingSeatId(seatId);
      return seatsApi.detachHuman(selectedCompanyId!, seatId, null);
    },
    onSuccess: async (result) => {
      await invalidateSeatViews();
      pushToast({
        tone: "success",
        title: "Human detached from seat",
        body:
          result.fallbackReassignedIssueCount > 0
            ? `${result.fallbackReassignedIssueCount} issues were reassigned to the fallback agent.`
            : "No open issues needed reassignment.",
      });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Detach failed",
        body: error instanceof Error ? error.message : "Unknown error",
      });
    },
    onSettled: () => {
      setMutationPendingSeatId(null);
    },
  });

  const updateSeatPermissions = useMutation({
    mutationFn: async ({ seatId, delegatedPermissions }: { seatId: string; delegatedPermissions: string[] }) => {
      setMutationPendingSeatId(seatId);
      return seatsApi.update(selectedCompanyId!, seatId, { delegatedPermissions });
    },
    onSuccess: async (result) => {
      await invalidateSeatViews();
      await queryClient.invalidateQueries({ queryKey: queryKeys.seats.detail(selectedCompanyId!, result.id) });
      setPermissionsDialogNode(null);
      setSelectedPermissions([]);
      pushToast({ tone: "success", title: "Seat permissions updated" });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Permission update failed",
        body: error instanceof Error ? error.message : "Unknown error",
      });
    },
    onSettled: () => {
      setMutationPendingSeatId(null);
    },
  });

  useEffect(() => {
    if (seatDetail && permissionsDialogNode?.seatId === seatDetail.id) {
      setSelectedPermissions(seatDetail.delegatedPermissions);
    }
  }, [seatDetail, permissionsDialogNode]);

  if (!selectedCompanyId) {
    return <EmptyState icon={GitBranch} message="Select a company to view org chart." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => backfillSeats.mutate()}
          disabled={backfillSeats.isPending}
        >
          <RefreshCcw className="mr-1.5 h-3.5 w-3.5" />
          {backfillSeats.isPending ? "Backfilling…" : "Backfill Seats"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => reconcileModes.mutate()}
          disabled={reconcileModes.isPending}
        >
          <RefreshCcw className="mr-1.5 h-3.5 w-3.5" />
          {reconcileModes.isPending ? "Reconciling…" : "Reconcile Modes"}
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {data && data.length === 0 && (
        <EmptyState
          icon={GitBranch}
          message="No agents in the organization. Create agents to build your org chart."
        />
      )}

      {data && data.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="border border-border py-1">
            <OrgTree
              nodes={data}
              hrefFn={(id) => `/agents/${id}`}
              onSelect={setSelectedSeatNode}
              onAttach={(node) => {
                setAttachDialogNode(node);
                setAttachUserId("");
              }}
              onDetach={(node) => {
                if (!node.seatId) return;
                detachHuman.mutate(node.seatId);
              }}
              onEditPermissions={(node) => {
                setPermissionsDialogNode(node);
                setSelectedPermissions([]);
              }}
              mutationPendingSeatId={mutationPendingSeatId}
            />
          </div>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Seat Detail</CardTitle>
              <CardDescription>
                {selectedSeatDetail?.name
                  ? `${selectedSeatDetail.name} seat 상태와 위임 권한`
                  : "Seat를 선택하면 여기에서 상태를 확인할 수 있습니다."}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              {!selectedSeatDetail ? (
                <p className="text-muted-foreground">Org 트리에서 `Details`를 눌러 seat 정보를 확인하세요.</p>
              ) : (
                <>
                  <div className="space-y-1">
                    <div className="font-medium">{selectedSeatDetail.name}</div>
                    <div className="text-muted-foreground">{selectedSeatDetail.title || "No title"}</div>
                  </div>
                  <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-2 text-sm">
                    <dt className="text-muted-foreground">Slug</dt>
                    <dd className="truncate">{selectedSeatDetail.slug}</dd>
                    <dt className="text-muted-foreground">Seat Type</dt>
                    <dd>{selectedSeatDetail.seatType}</dd>
                    <dt className="text-muted-foreground">Mode</dt>
                    <dd>{selectedSeatDetail.operatingMode}</dd>
                    <dt className="text-muted-foreground">Status</dt>
                    <dd>{selectedSeatDetail.status}</dd>
                    <dt className="text-muted-foreground">Human</dt>
                    <dd>{selectedSeatDetail.currentHumanUserId || "None"}</dd>
                    <dt className="text-muted-foreground">Default Agent</dt>
                    <dd className="truncate">{selectedSeatDetail.defaultAgentId || "None"}</dd>
                    <dt className="text-muted-foreground">Delegated</dt>
                    <dd>{formatDelegatedPermissions(selectedSeatDetail.delegatedPermissions) || "none"}</dd>
                  </dl>
                  <div className="flex flex-wrap gap-2 pt-1">
                    {selectedSeatNode && primarySeatAction(selectedSeatNode) === "attach" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setAttachDialogNode(selectedSeatNode);
                          setAttachUserId("");
                        }}
                      >
                        <UserPlus className="mr-1.5 h-3.5 w-3.5" />
                        Attach
                      </Button>
                    ) : null}
                    {selectedSeatNode?.seatId && primarySeatAction(selectedSeatNode) === "detach" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => detachHuman.mutate(selectedSeatNode.seatId!)}
                      >
                        <UserMinus className="mr-1.5 h-3.5 w-3.5" />
                        Detach
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        if (!selectedSeatNode) return;
                        setPermissionsDialogNode(selectedSeatNode);
                        setSelectedPermissions(selectedSeatDetail.delegatedPermissions);
                      }}
                    >
                      Edit Permissions
                    </Button>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      <Dialog open={Boolean(attachDialogNode)} onOpenChange={(open) => !open && setAttachDialogNode(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Attach Human Operator</DialogTitle>
            <DialogDescription>
              {attachDialogNode?.name ? `${attachDialogNode.name} seat에 human operator를 붙입니다.` : "Seat에 human operator를 붙입니다."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label className="text-sm font-medium">User ID</label>
            <Input
              value={attachUserId}
              onChange={(e) => setAttachUserId(e.target.value)}
              placeholder="user-123"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAttachDialogNode(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (!attachDialogNode?.seatId || !attachUserId.trim()) return;
                attachHuman.mutate({ seatId: attachDialogNode.seatId, userId: attachUserId.trim() });
              }}
              disabled={!attachDialogNode?.seatId || !attachUserId.trim() || attachHuman.isPending}
            >
              {attachHuman.isPending ? "Attaching…" : "Attach"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(permissionsDialogNode)} onOpenChange={(open) => !open && setPermissionsDialogNode(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Delegated Permissions</DialogTitle>
            <DialogDescription>
              {permissionsDialogNode?.name
                ? `${permissionsDialogNode.name} seat에 위임 권한을 설정합니다.`
                : "Seat delegated permissions를 설정합니다."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label className="text-sm font-medium">Delegated Permissions</label>
            <div className="space-y-2 rounded-md border border-border p-3">
              {seatPermissionOptions.map((option) => {
                const checked = selectedPermissions.includes(option.key);
                return (
                  <label key={option.key} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={checked}
                      onCheckedChange={(next) => {
                        setSelectedPermissions((current) => {
                          if (next) return Array.from(new Set([...current, option.key]));
                          return current.filter((value) => value !== option.key);
                        });
                      }}
                    />
                    <span>{option.label}</span>
                  </label>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground">
              Current: {formatDelegatedPermissions(selectedPermissions) || "none"}
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPermissionsDialogNode(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (!permissionsDialogNode?.seatId) return;
                updateSeatPermissions.mutate({
                  seatId: permissionsDialogNode.seatId,
                  delegatedPermissions: selectedPermissions,
                });
              }}
              disabled={!permissionsDialogNode?.seatId || updateSeatPermissions.isPending}
            >
              {updateSeatPermissions.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
