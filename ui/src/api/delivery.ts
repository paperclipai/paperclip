import type {
  CreateDeliveryControlUpdate,
  DeliverySnapshotV1,
  ExternalOperationV1,
  IssueComment,
} from "@paperclipai/shared";
import { api } from "./client";

export type DeliveryControlUpdateResponse = {
  comment: IssueComment;
  snapshot: DeliverySnapshotV1;
};

export const deliveryApi = {
  getSnapshot: (issueId: string) =>
    api.get<DeliverySnapshotV1>(`/issues/${issueId}/delivery-snapshot`),
  listExternalOperations: (issueId: string) =>
    api.get<ExternalOperationV1[]>(`/issues/${issueId}/external-operations`),
  publishControlUpdate: (issueId: string, input: CreateDeliveryControlUpdate) =>
    api.post<DeliveryControlUpdateResponse>(`/issues/${issueId}/control-updates`, input),
};
