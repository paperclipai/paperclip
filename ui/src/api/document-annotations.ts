import type {
  CreateDocumentAnnotationCommentRequest,
  CreateDocumentAnnotationThreadRequest,
  DocumentAnnotationComment,
  DocumentAnnotationThread,
  DocumentAnnotationThreadStatus,
  DocumentAnnotationThreadWithComments,
  UpdateDocumentAnnotationThreadRequest,
} from "@paperclipai/shared";
import { api } from "./client";

export type DocumentAnnotationListFilter = "open" | "resolved" | "all";

export type DocumentAnnotationTarget =
  | { kind: "issue"; issueId: string; documentKey: string }
  | { kind: "routine"; routineId: string; documentKey: "description" };

function issueTarget(issueId: string, documentKey: string): DocumentAnnotationTarget {
  return { kind: "issue", issueId, documentKey };
}

function targetBasePath(target: DocumentAnnotationTarget) {
  if (target.kind === "routine") {
    return `/routines/${target.routineId}/description/annotations`;
  }
  return `/issues/${target.issueId}/documents/${encodeURIComponent(target.documentKey)}/annotations`;
}

export const documentAnnotationsApi = {
  list: (
    issueId: string,
    key: string,
    options: { status?: DocumentAnnotationListFilter; includeComments?: boolean } = {},
  ) => documentAnnotationsApi.listForTarget(issueTarget(issueId, key), options),
  listForTarget: (
    target: DocumentAnnotationTarget,
    options: { status?: DocumentAnnotationListFilter; includeComments?: boolean } = {},
  ) => {
    const params = new URLSearchParams();
    if (options.status) params.set("status", options.status);
    if (options.includeComments) params.set("includeComments", "true");
    const qs = params.toString();
    return api.get<DocumentAnnotationThreadWithComments[]>(
      `${targetBasePath(target)}${qs ? `?${qs}` : ""}`,
    );
  },
  get: (issueId: string, key: string, threadId: string) =>
    documentAnnotationsApi.getForTarget(issueTarget(issueId, key), threadId),
  getForTarget: (target: DocumentAnnotationTarget, threadId: string) =>
    api.get<DocumentAnnotationThreadWithComments>(
      `${targetBasePath(target)}/${threadId}`,
    ),
  create: (issueId: string, key: string, data: CreateDocumentAnnotationThreadRequest) =>
    documentAnnotationsApi.createForTarget(issueTarget(issueId, key), data),
  createForTarget: (target: DocumentAnnotationTarget, data: CreateDocumentAnnotationThreadRequest) =>
    api.post<DocumentAnnotationThreadWithComments>(
      targetBasePath(target),
      data,
    ),
  addComment: (
    issueId: string,
    key: string,
    threadId: string,
    data: CreateDocumentAnnotationCommentRequest,
  ) => documentAnnotationsApi.addCommentForTarget(issueTarget(issueId, key), threadId, data),
  addCommentForTarget: (
    target: DocumentAnnotationTarget,
    threadId: string,
    data: CreateDocumentAnnotationCommentRequest,
  ) =>
    api.post<DocumentAnnotationComment>(
      `${targetBasePath(target)}/${threadId}/comments`,
      data,
    ),
  updateStatus: (
    issueId: string,
    key: string,
    threadId: string,
    status: DocumentAnnotationThreadStatus,
  ) => documentAnnotationsApi.updateStatusForTarget(issueTarget(issueId, key), threadId, status),
  updateStatusForTarget: (
    target: DocumentAnnotationTarget,
    threadId: string,
    status: DocumentAnnotationThreadStatus,
  ) => {
    const payload: UpdateDocumentAnnotationThreadRequest = { status };
    return api.patch<DocumentAnnotationThread>(
      `${targetBasePath(target)}/${threadId}`,
      payload,
    );
  },
};
