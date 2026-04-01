import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PermissionKey, SeatPauseReason } from "@paperclipai/shared";
import type { OrgNode } from "../api/agents";
import { seatsApi } from "../api/seats";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { activeUserSeatCandidates } from "../lib/seat-members";

type OperatorManagedSeatPauseReason = Exclude<SeatPauseReason, "budget_enforcement">;

export function useSeatManagement(selectedCompanyId: string | null | undefined) {
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [attachDialogNode, setAttachDialogNode] = useState<OrgNode | null>(null);
  const [selectedSeatNode, setSelectedSeatNode] = useState<OrgNode | null>(null);
  const [attachUserId, setAttachUserId] = useState("");
  const [permissionsDialogNode, setPermissionsDialogNode] = useState<OrgNode | null>(null);
  const [selectedPermissions, setSelectedPermissions] = useState<PermissionKey[]>([]);
  const [pauseDialogNode, setPauseDialogNode] = useState<OrgNode | null>(null);
  const [selectedPauseReason, setSelectedPauseReason] = useState<OperatorManagedSeatPauseReason>("manual_admin");
  const [mutationPendingSeatId, setMutationPendingSeatId] = useState<string | null>(null);

  const { data: permissionsSeatDetail } = useQuery({
    queryKey: permissionsDialogNode?.seatId
      ? queryKeys.seats.detail(selectedCompanyId!, permissionsDialogNode.seatId)
      : ["seats", "detail", "none"],
    queryFn: () => seatsApi.detail(selectedCompanyId!, permissionsDialogNode!.seatId!),
    enabled: !!selectedCompanyId && !!permissionsDialogNode?.seatId,
  });

  const { data: selectedSeatDetail } = useQuery({
    queryKey: selectedSeatNode?.seatId
      ? queryKeys.seats.detail(selectedCompanyId!, selectedSeatNode.seatId)
      : ["seats", "detail", "selected-none"],
    queryFn: () => seatsApi.detail(selectedCompanyId!, selectedSeatNode!.seatId!),
    enabled: !!selectedCompanyId && !!selectedSeatNode?.seatId,
  });

  const { data: companyMembers = [], isLoading: isLoadingCompanyMembers } = useQuery({
    queryKey: ["company-members", selectedCompanyId],
    queryFn: () => seatsApi.attachableMembers(selectedCompanyId!),
    enabled: !!selectedCompanyId && !!attachDialogNode?.seatId,
  });

  const attachableMembers = activeUserSeatCandidates(companyMembers);

  useEffect(() => {
    if (permissionsSeatDetail && permissionsDialogNode?.seatId === permissionsSeatDetail.id) {
      setSelectedPermissions(permissionsSeatDetail.delegatedPermissions);
    }
  }, [permissionsSeatDetail, permissionsDialogNode]);

  const invalidateSeatViews = async () => {
    if (!selectedCompanyId) return;
    const invalidations: Promise<unknown>[] = [
      queryClient.invalidateQueries({ queryKey: queryKeys.org(selectedCompanyId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(selectedCompanyId) }),
    ];
    if (selectedSeatNode?.seatId) {
      invalidations.push(
        queryClient.invalidateQueries({
          queryKey: queryKeys.seats.detail(selectedCompanyId, selectedSeatNode.seatId),
        }),
      );
    }
    if (permissionsDialogNode?.seatId) {
      invalidations.push(
        queryClient.invalidateQueries({
          queryKey: queryKeys.seats.detail(selectedCompanyId, permissionsDialogNode.seatId),
        }),
      );
    }
    await Promise.all(invalidations);
  };

  const attachHuman = useMutation({
    mutationFn: async ({ seatId, userId }: { seatId: string; userId: string }) => {
      setMutationPendingSeatId(seatId);
      return seatsApi.attachHuman(selectedCompanyId!, seatId, userId);
    },
    onSuccess: async () => {
      await invalidateSeatViews();
      setAttachDialogNode(null);
      setAttachUserId("");
      pushToast({ tone: "success", title: "Human attached to seat" });
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
    mutationFn: async ({ seatId, delegatedPermissions }: { seatId: string; delegatedPermissions: PermissionKey[] }) => {
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

  const pauseSeat = useMutation({
    mutationFn: async ({ seatId, pauseReason }: { seatId: string; pauseReason: OperatorManagedSeatPauseReason }) => {
      setMutationPendingSeatId(seatId);
      return seatsApi.pause(selectedCompanyId!, seatId, pauseReason);
    },
    onSuccess: async () => {
      await invalidateSeatViews();
      setPauseDialogNode(null);
      setSelectedPauseReason("manual_admin");
      pushToast({ tone: "success", title: "Seat pause updated" });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Pause update failed",
        body: error instanceof Error ? error.message : "Unknown error",
      });
    },
    onSettled: () => {
      setMutationPendingSeatId(null);
    },
  });

  const resumeSeat = useMutation({
    mutationFn: async ({ seatId, pauseReason }: { seatId: string; pauseReason?: OperatorManagedSeatPauseReason | null }) => {
      setMutationPendingSeatId(seatId);
      return seatsApi.resume(selectedCompanyId!, seatId, pauseReason ?? null);
    },
    onSuccess: async () => {
      await invalidateSeatViews();
      pushToast({ tone: "success", title: "Seat resumed" });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Resume failed",
        body: error instanceof Error ? error.message : "Unknown error",
      });
    },
    onSettled: () => {
      setMutationPendingSeatId(null);
    },
  });

  const openAttachDialog = (node: OrgNode) => {
    setAttachDialogNode(node);
    setAttachUserId("");
  };

  const openPermissionsDialog = (node: OrgNode, delegatedPermissions: PermissionKey[] = []) => {
    setPermissionsDialogNode(node);
    setSelectedPermissions(delegatedPermissions);
  };

  const openPauseDialog = (
    node: OrgNode,
    pauseReason: OperatorManagedSeatPauseReason = "manual_admin",
  ) => {
    setPauseDialogNode(node);
    setSelectedPauseReason(pauseReason);
  };

  const submitAttach = () => {
    if (!attachDialogNode?.seatId) return;
    const userId = attachUserId.trim();
    if (!attachableMembers.some((member) => member.userId === userId)) return;
    attachHuman.mutate({ seatId: attachDialogNode.seatId, userId: attachUserId.trim() });
  };

  const submitPermissions = () => {
    if (!permissionsDialogNode?.seatId) return;
    updateSeatPermissions.mutate({
      seatId: permissionsDialogNode.seatId,
      delegatedPermissions: selectedPermissions,
    });
  };

  const submitPause = () => {
    if (!pauseDialogNode?.seatId) return;
    pauseSeat.mutate({
      seatId: pauseDialogNode.seatId,
      pauseReason: selectedPauseReason,
    });
  };

  const submitResume = (seatId: string, pauseReason?: OperatorManagedSeatPauseReason | null) => {
    resumeSeat.mutate({
      seatId,
      pauseReason: pauseReason ?? null,
    });
  };

  return {
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
    permissionsSeatDetail,
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
  };
}
