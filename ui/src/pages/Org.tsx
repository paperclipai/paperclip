import { useEffect, useState } from "react";
import { Link } from "@/lib/router";
import { useMutation, useQuery } from "@tanstack/react-query";
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
import { formatDelegatedPermissions } from "../lib/seat-permissions";
import { formatSeatPauseReason, formatSeatPauseReasons } from "../lib/seat-pause";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { useSeatManagement } from "../hooks/useSeatManagement";
import { SeatAttachDialog } from "../components/SeatAttachDialog";
import { SeatPauseDialog } from "../components/SeatPauseDialog";
import { SeatPermissionsDialog } from "../components/SeatPermissionsDialog";
import { useI18n } from "../i18n";

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
  const { t } = useI18n();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const {
    attachDialogNode,
    attachHuman,
    attachUserId,
    attachableMembers,
    detachHuman,
    invalidateSeatViews,
    isLoadingCompanyMembers,
    mutationPendingSeatId,
    openAttachDialog,
    openPauseDialog,
    openPermissionsDialog,
    pauseDialogNode,
    pauseSeat,
    permissionsDialogNode,
    resumeSeat,
    selectedPermissions,
    selectedPauseReason,
    selectedSeatDetail,
    selectedSeatNode,
    setAttachDialogNode,
    setAttachUserId,
    setPauseDialogNode,
    setPermissionsDialogNode,
    setSelectedPermissions,
    setSelectedPauseReason,
    setSelectedSeatNode,
    submitAttach,
    submitPause,
    submitPermissions,
    submitResume,
    updateSeatPermissions,
  } = useSeatManagement(selectedCompanyId);

  useEffect(() => {
    setBreadcrumbs([{ label: t("orgChart.title") }]);
  }, [setBreadcrumbs, t]);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.org(selectedCompanyId!),
    queryFn: () => agentsApi.org(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const backfillSeats = useMutation({
    mutationFn: () => seatsApi.backfill(selectedCompanyId!),
    onSuccess: async (result) => {
      await invalidateSeatViews();
      pushToast({
        tone: "success",
        title: t("orgChart.backfillComplete"),
        body: `${result.seatsCreated} seats created, ${result.ownershipBackfills.issues} issue owners backfilled.`,
      });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: t("orgChart.backfillFailed"),
        body: error instanceof Error ? error.message : t("orgChart.unknownError"),
      });
    },
  });

  const reconcileModes = useMutation({
    mutationFn: () => seatsApi.reconcileModes(selectedCompanyId!),
    onSuccess: async (result) => {
      await invalidateSeatViews();
      pushToast({
        tone: "success",
        title: t("orgChart.reconciled"),
        body: `${result.updatedSeatCount} of ${result.scannedSeatCount} seats updated.`,
      });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: t("orgChart.reconcileFailed"),
        body: error instanceof Error ? error.message : t("orgChart.unknownError"),
      });
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={GitBranch} message={t("orgChart.selectCompany")} />;
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
          {backfillSeats.isPending ? t("orgChart.backfilling") : t("orgChart.backfillSeats")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => reconcileModes.mutate()}
          disabled={reconcileModes.isPending}
        >
          <RefreshCcw className="mr-1.5 h-3.5 w-3.5" />
          {reconcileModes.isPending ? t("orgChart.reconciling") : t("orgChart.reconcileModes")}
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {data && data.length === 0 && (
        <EmptyState
          icon={GitBranch}
          message={t("orgChart.noAgents")}
        />
      )}

      {data && data.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="border border-border py-1">
            <OrgTree
              nodes={data}
              hrefFn={(id) => `/agents/${id}`}
              onSelect={setSelectedSeatNode}
              onAttach={openAttachDialog}
              onDetach={(node) => {
                if (!node.seatId) return;
                detachHuman.mutate(node.seatId);
              }}
              onEditPermissions={(node) => openPermissionsDialog(node)}
              mutationPendingSeatId={mutationPendingSeatId}
            />
          </div>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">{t("orgChart.seatDetail")}</CardTitle>
              <CardDescription>
                {selectedSeatDetail?.name
                  ? t("orgChart.seatDetailDescription", { name: selectedSeatDetail.name })
                  : t("orgChart.selectSeat")}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              {!selectedSeatDetail ? (
                <p className="text-muted-foreground">{t("orgChart.selectDetails")}</p>
              ) : (
                <>
                  <div className="space-y-1">
                    <div className="font-medium">{selectedSeatDetail.name}</div>
                    <div className="text-muted-foreground">{selectedSeatDetail.title || t("orgChart.noTitle")}</div>
                  </div>
                  <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-2 text-sm">
                    <dt className="text-muted-foreground">{t("common.slug")}</dt>
                    <dd className="truncate">{selectedSeatDetail.slug}</dd>
                    <dt className="text-muted-foreground">{t("common.seatType")}</dt>
                    <dd>{selectedSeatDetail.seatType}</dd>
                    <dt className="text-muted-foreground">{t("common.mode")}</dt>
                    <dd>{selectedSeatDetail.operatingMode}</dd>
                    <dt className="text-muted-foreground">{t("common.status")}</dt>
                    <dd>{selectedSeatDetail.status}</dd>
                    <dt className="text-muted-foreground">{t("common.pauseReason")}</dt>
                    <dd>{formatSeatPauseReason(selectedSeatDetail.pauseReason) || t("common.none")}</dd>
                    <dt className="text-muted-foreground">{t("common.pauseStack")}</dt>
                    <dd>{formatSeatPauseReasons(selectedSeatDetail.pauseReasons)}</dd>
                    <dt className="text-muted-foreground">{t("common.human")}</dt>
                    <dd>{selectedSeatDetail.currentHumanUserId || t("common.none")}</dd>
                    <dt className="text-muted-foreground">{t("common.defaultAgent")}</dt>
                    <dd className="truncate">{selectedSeatDetail.defaultAgentId || t("common.none")}</dd>
                    <dt className="text-muted-foreground">{t("common.delegated")}</dt>
                    <dd>{formatDelegatedPermissions(selectedSeatDetail.delegatedPermissions) || t("common.none")}</dd>
                  </dl>
                  <div className="flex flex-wrap gap-2 pt-1">
                    {selectedSeatNode?.seatId ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => openPauseDialog(selectedSeatNode, selectedSeatDetail.pauseReason === "maintenance" ? "maintenance" : "manual_admin")}
                      >
                        Pause
                      </Button>
                    ) : null}
                    {selectedSeatNode?.seatId && selectedSeatDetail.pauseReasons.some((reason) => reason !== "budget_enforcement") ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => submitResume(selectedSeatNode.seatId!, null)}
                      >
                        Resume Operator Pause
                      </Button>
                    ) : null}
                    {selectedSeatNode && primarySeatAction(selectedSeatNode) === "attach" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => openAttachDialog(selectedSeatNode)}
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
                      onClick={() => selectedSeatNode && openPermissionsDialog(selectedSeatNode, selectedSeatDetail.delegatedPermissions)}
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

      <SeatAttachDialog
        open={Boolean(attachDialogNode)}
        seatName={attachDialogNode?.name}
        userId={attachUserId}
        memberOptions={attachableMembers}
        isLoadingMembers={isLoadingCompanyMembers}
        isPending={attachHuman.isPending}
        onOpenChange={(open) => !open && setAttachDialogNode(null)}
        onUserIdChange={setAttachUserId}
        onSubmit={submitAttach}
      />

      <SeatPauseDialog
        open={Boolean(pauseDialogNode)}
        seatName={pauseDialogNode?.name}
        pauseReason={selectedPauseReason}
        isPending={pauseSeat.isPending || resumeSeat.isPending}
        onOpenChange={(open) => !open && setPauseDialogNode(null)}
        onPauseReasonChange={setSelectedPauseReason}
        onSubmit={submitPause}
      />

      <SeatPermissionsDialog
        open={Boolean(permissionsDialogNode)}
        seatName={permissionsDialogNode?.name}
        selectedPermissions={selectedPermissions}
        isPending={updateSeatPermissions.isPending}
        onOpenChange={(open) => !open && setPermissionsDialogNode(null)}
        onSelectedPermissionsChange={setSelectedPermissions}
        onSubmit={submitPermissions}
      />
    </div>
  );
}
