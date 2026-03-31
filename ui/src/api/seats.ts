import type {
  PermissionKey,
  SeatOperatingMode,
  SeatPauseReason,
  SeatStatus,
  SeatType,
} from "@paperclipai/shared";
import type { CompanyMember } from "./access";
import { api } from "./client";

export interface SeatMutationResult {
  seatId: string;
  companyId: string;
  operatingMode: SeatOperatingMode;
  currentHumanUserId: string | null;
  fallbackReassignedIssueCount: number;
}

export interface SeatBackfillResult {
  seatsCreated: number;
  seatsUpdated: number;
  primaryOccupanciesCreated: number;
  agentsLinkedToSeats: number;
  ownershipBackfills: {
    issues: number;
    projects: number;
    goals: number;
    routines: number;
  };
  warnings: Array<{
    code: string;
    companyId: string;
    entityType: string;
    entityId: string;
    details?: Record<string, unknown>;
  }>;
}

export interface SeatModeReconcileResult {
  companyId: string;
  scannedSeatCount: number;
  updatedSeatCount: number;
}

export interface SeatDetail {
  id: string;
  companyId: string;
  slug: string;
  name: string;
  title: string | null;
  seatType: SeatType;
  status: SeatStatus;
  pauseReason: SeatPauseReason | null;
  pauseReasons: SeatPauseReason[];
  operatingMode: SeatOperatingMode;
  currentHumanUserId: string | null;
  delegatedPermissions: PermissionKey[];
  defaultAgentId: string | null;
}

export const seatsApi = {
  attachableMembers: (companyId: string) =>
    api.get<CompanyMember[]>(`/companies/${companyId}/seats/attachable-members`),
  detail: (companyId: string, seatId: string) =>
    api.get<SeatDetail>(`/companies/${companyId}/seats/${seatId}`),
  update: (companyId: string, seatId: string, data: { delegatedPermissions: PermissionKey[] }) =>
    api.patch<SeatDetail>(`/companies/${companyId}/seats/${seatId}`, data),
  pause: (companyId: string, seatId: string, pauseReason: Exclude<SeatPauseReason, "budget_enforcement">) =>
    api.post<SeatDetail>(`/companies/${companyId}/seats/${seatId}/pause`, { pauseReason }),
  resume: (companyId: string, seatId: string, pauseReason?: Exclude<SeatPauseReason, "budget_enforcement"> | null) =>
    api.post<SeatDetail>(`/companies/${companyId}/seats/${seatId}/resume`, { pauseReason: pauseReason ?? null }),
  attachHuman: (companyId: string, seatId: string, userId: string) =>
    api.post<SeatMutationResult>(`/companies/${companyId}/seats/${seatId}/attach-human`, { userId }),
  detachHuman: (companyId: string, seatId: string, userId?: string | null) =>
    api.post<SeatMutationResult>(`/companies/${companyId}/seats/${seatId}/detach-human`, { userId: userId ?? null }),
  backfill: (companyId: string) =>
    api.post<SeatBackfillResult>(`/companies/${companyId}/seats/backfill`, {}),
  reconcileModes: (companyId: string) =>
    api.post<SeatModeReconcileResult>(`/companies/${companyId}/seats/reconcile-modes`, {}),
};
