import {
  agents,
  assets,
  documentRevisions,
  goals,
  issueAttachments,
  issueComments,
  issueDocuments,
  issues,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";

type IssueRow = typeof issues.$inferSelect;
type CommentRow = typeof issueComments.$inferSelect;
type AgentRow = typeof agents.$inferSelect;
type ProjectRow = typeof projects.$inferSelect;
type ProjectWorkspaceRow = typeof projectWorkspaces.$inferSelect;
type GoalRow = typeof goals.$inferSelect;
type IssueDocumentLinkRow = typeof issueDocuments.$inferSelect;
type DocumentRevisionTableRow = typeof documentRevisions.$inferSelect;
type IssueAttachmentTableRow = typeof issueAttachments.$inferSelect;
type AssetRow = typeof assets.$inferSelect;

export const WORKTREE_MERGE_SCOPES = ["issues", "comments"] as const;
export type WorktreeMergeScope = (typeof WORKTREE_MERGE_SCOPES)[number];

export type ImportAdjustment =
  | "clear_assignee_agent"
  | "clear_project"
  | "clear_project_workspace"
  | "clear_goal"
  | "clear_author_agent"
  | "coerce_in_progress_to_todo"
  | "clear_document_agent"
  | "clear_document_revision_agent"
  | "clear_attachment_agent";

export type IssueMergeAction = "skip_existing" | "insert";
export type CommentMergeAction = "skip_existing" | "skip_missing_parent" | "insert";

export type PlannedIssueInsert = {
  source: IssueRow;
  action: "insert";
  previewIssueNumber: number;
  previewIdentifier: string;
  targetStatus: string;
  targetAssigneeAgentId: string | null;
  targetCreatedByAgentId: string | null;
  targetProjectId: string | null;
  targetProjectWorkspaceId: string | null;
  targetGoalId: string | null;
  projectResolution: "preserved" | "cleared" | "mapped" | "imported";
  mappedProjectName: string | null;
  adjustments: ImportAdjustment[];
};

export type PlannedIssueSkip = {
  source: IssueRow;
  action: "skip_existing";
  driftKeys: string[];
};

export type PlannedCommentInsert = {
  source: CommentRow;
  action: "insert";
  targetAuthorAgentId: string | null;
  adjustments: ImportAdjustment[];
};

export type PlannedCommentSkip = {
  source: CommentRow;
  action: "skip_existing" | "skip_missing_parent";
};

export type IssueDocumentRow = {
  id: IssueDocumentLinkRow["id"];
  companyId: IssueDocumentLinkRow["companyId"];
  issueId: IssueDocumentLinkRow["issueId"];
  documentId: IssueDocumentLinkRow["documentId"];
  key: IssueDocumentLinkRow["key"];
  linkCreatedAt: IssueDocumentLinkRow["createdAt"];
  linkUpdatedAt: IssueDocumentLinkRow["updatedAt"];
  title: string | null;
  format: string;
  latestBody: string;
  latestRevisionId: string | null;
  latestRevisionNumber: number;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  updatedByAgentId: string | null;
  updatedByUserId: string | null;
  documentCreatedAt: Date;
  documentUpdatedAt: Date;
};

export type DocumentRevisionRow = {
  id: DocumentRevisionTableRow["id"];
  companyId: DocumentRevisionTableRow["companyId"];
  documentId: DocumentRevisionTableRow["documentId"];
  revisionNumber: DocumentRevisionTableRow["revisionNumber"];
  body: DocumentRevisionTableRow["body"];
  changeSummary: DocumentRevisionTableRow["changeSummary"];
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
};

export type IssueAttachmentRow = {
  id: IssueAttachmentTableRow["id"];
  companyId: IssueAttachmentTableRow["companyId"];
  issueId: IssueAttachmentTableRow["issueId"];
  issueCommentId: IssueAttachmentTableRow["issueCommentId"];
  assetId: IssueAttachmentTableRow["assetId"];
  provider: AssetRow["provider"];
  objectKey: AssetRow["objectKey"];
  contentType: AssetRow["contentType"];
  byteSize: AssetRow["byteSize"];
  sha256: AssetRow["sha256"];
  originalFilename: AssetRow["originalFilename"];
  createdByAgentId: string | null;
  createdByUserId: string | null;
  assetCreatedAt: Date;
  assetUpdatedAt: Date;
  attachmentCreatedAt: Date;
  attachmentUpdatedAt: Date;
};

export type PlannedDocumentRevisionInsert = {
  source: DocumentRevisionRow;
  targetRevisionNumber: number;
  targetCreatedByAgentId: string | null;
  adjustments: ImportAdjustment[];
};

export type PlannedIssueDocumentInsert = {
  source: IssueDocumentRow;
  action: "insert";
  targetCreatedByAgentId: string | null;
  targetUpdatedByAgentId: string | null;
  latestRevisionId: string | null;
  latestRevisionNumber: number;
  revisionsToInsert: PlannedDocumentRevisionInsert[];
  adjustments: ImportAdjustment[];
};

export type PlannedIssueDocumentMerge = {
  source: IssueDocumentRow;
  action: "merge_existing";
  targetCreatedByAgentId: string | null;
  targetUpdatedByAgentId: string | null;
  latestRevisionId: string | null;
  latestRevisionNumber: number;
  revisionsToInsert: PlannedDocumentRevisionInsert[];
  adjustments: ImportAdjustment[];
};

export type PlannedIssueDocumentSkip = {
  source: IssueDocumentRow;
  action: "skip_existing" | "skip_missing_parent" | "skip_conflicting_key";
};

export type PlannedAttachmentInsert = {
  source: IssueAttachmentRow;
  action: "insert";
  targetIssueCommentId: string | null;
  targetCreatedByAgentId: string | null;
  adjustments: ImportAdjustment[];
};

export type PlannedAttachmentSkip = {
  source: IssueAttachmentRow;
  action: "skip_existing" | "skip_missing_parent";
};

export type PlannedProjectImport = {
  source: ProjectRow;
  targetLeadAgentId: string | null;
  targetGoalId: string | null;
  workspaces: ProjectWorkspaceRow[];
};

export type WorktreeMergePlan = {
  companyId: string;
  companyName: string;
  issuePrefix: string;
  previewIssueCounterStart: number;
  scopes: WorktreeMergeScope[];
  projectImports: PlannedProjectImport[];
  issuePlans: Array<PlannedIssueInsert | PlannedIssueSkip>;
  commentPlans: Array<PlannedCommentInsert | PlannedCommentSkip>;
  documentPlans: Array<PlannedIssueDocumentInsert | PlannedIssueDocumentMerge | PlannedIssueDocumentSkip>;
  attachmentPlans: Array<PlannedAttachmentInsert | PlannedAttachmentSkip>;
  counts: {
    projectsToImport: number;
    issuesToInsert: number;
    issuesExisting: number;
    issueDrift: number;
    commentsToInsert: number;
    commentsExisting: number;
    commentsMissingParent: number;
    documentsToInsert: number;
    documentsToMerge: number;
    documentsExisting: number;
    documentsConflictingKey: number;
    documentsMissingParent: number;
    documentRevisionsToInsert: number;
    attachmentsToInsert: number;
    attachmentsExisting: number;
    attachmentsMissingParent: number;
  };
  adjustments: Record<ImportAdjustment, number>;
};

function compareIssueCoreFields(source: IssueRow, target: IssueRow): string[] {
  const driftKeys: string[] = [];
  if (source.title !== target.title) driftKeys.push("title");
  if ((source.description ?? null) !== (target.description ?? null)) driftKeys.push("description");
  if (source.status !== target.status) driftKeys.push("status");
  if (source.priority !== target.priority) driftKeys.push("priority");
  if ((source.parentId ?? null) !== (target.parentId ?? null)) driftKeys.push("parentId");
  if ((source.projectId ?? null) !== (target.projectId ?? null)) driftKeys.push("projectId");
  if ((source.projectWorkspaceId ?? null) !== (target.projectWorkspaceId ?? null)) driftKeys.push("projectWorkspaceId");
  if ((source.goalId ?? null) !== (target.goalId ?? null)) driftKeys.push("goalId");
  if ((source.assigneeAgentId ?? null) !== (target.assigneeAgentId ?? null)) driftKeys.push("assigneeAgentId");
  if ((source.assigneeUserId ?? null) !== (target.assigneeUserId ?? null)) driftKeys.push("assigneeUserId");
  return driftKeys;
}

function incrementAdjustment(
  counts: Record<ImportAdjustment, number>,
  adjustment: ImportAdjustment,
): void {
  counts[adjustment] += 1;
}

function groupBy<T>(rows: T[], keyFor: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyFor(row);
    const existing = out.get(key);
    if (existing) {
      existing.push(row);
    } else {
      out.set(key, [row]);
    }
  }
  return out;
}

function sameDate(left: Date, right: Date): boolean {
  return left.getTime() === right.getTime();
}

function sortDocumentRows(rows: IssueDocumentRow[]): IssueDocumentRow[] {
  return [...rows].sort((left, right) => {
    const createdDelta = left.documentCreatedAt.getTime() - right.documentCreatedAt.getTime();
    if (createdDelta !== 0) return createdDelta;
    const linkDelta = left.linkCreatedAt.getTime() - right.linkCreatedAt.getTime();
    if (linkDelta !== 0) return linkDelta;
    return left.documentId.localeCompare(right.documentId);
  });
}

function sortDocumentRevisions(rows: DocumentRevisionRow[]): DocumentRevisionRow[] {
  return [...rows].sort((left, right) => {
    const revisionDelta = left.revisionNumber - right.revisionNumber;
    if (revisionDelta !== 0) return revisionDelta;
    const createdDelta = left.createdAt.getTime() - right.createdAt.getTime();
    if (createdDelta !== 0) return createdDelta;
    return left.id.localeCompare(right.id);
  });
}

function sortAttachments(rows: IssueAttachmentRow[]): IssueAttachmentRow[] {
  return [...rows].sort((left, right) => {
    const createdDelta = left.attachmentCreatedAt.getTime() - right.attachmentCreatedAt.getTime();
    if (createdDelta !== 0) return createdDelta;
    return left.id.localeCompare(right.id);
  });
}

function sortIssuesForImport(sourceIssues: IssueRow[]): IssueRow[] {
  const byId = new Map(sourceIssues.map((issue) => [issue.id, issue]));
  const memoDepth = new Map<string, number>();

  const depthFor = (issue: IssueRow, stack = new Set<string>()): number => {
    const memoized = memoDepth.get(issue.id);
    if (memoized !== undefined) return memoized;
    if (!issue.parentId) {
      memoDepth.set(issue.id, 0);
      return 0;
    }
    if (stack.has(issue.id)) {
      memoDepth.set(issue.id, 0);
      return 0;
    }
    const parent = byId.get(issue.parentId);
    if (!parent) {
      memoDepth.set(issue.id, 0);
      return 0;
    }
    stack.add(issue.id);
    const depth = depthFor(parent, stack) + 1;
    stack.delete(issue.id);
    memoDepth.set(issue.id, depth);
    return depth;
  };

  return [...sourceIssues].sort((left, right) => {
    const depthDelta = depthFor(left) - depthFor(right);
    if (depthDelta !== 0) return depthDelta;
    const createdDelta = left.createdAt.getTime() - right.createdAt.getTime();
    if (createdDelta !== 0) return createdDelta;
    return left.id.localeCompare(right.id);
  });
}

export function parseWorktreeMergeScopes(rawValue: string | undefined): WorktreeMergeScope[] {
  if (!rawValue || rawValue.trim().length === 0) {
    return ["issues", "comments"];
  }

  const parsed = rawValue
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value): value is WorktreeMergeScope =>
      (WORKTREE_MERGE_SCOPES as readonly string[]).includes(value),
    );

  if (parsed.length === 0) {
    throw new Error(
      `Invalid scope "${rawValue}". Expected a comma-separated list of: ${WORKTREE_MERGE_SCOPES.join(", ")}.`,
    );
  }

  return [...new Set(parsed)];
}

export function buildWorktreeMergePlan(input: {
  companyId: string;
  companyName: string;
  issuePrefix: string;
  previewIssueCounterStart: number;
  scopes: WorktreeMergeScope[];
  sourceIssues: IssueRow[];
  targetIssues: IssueRow[];
  sourceComments: CommentRow[];
  targetComments: CommentRow[];
  sourceProjects?: ProjectRow[];
  sourceProjectWorkspaces?: ProjectWorkspaceRow[];
  sourceDocuments?: IssueDocumentRow[];
  targetDocuments?: IssueDocumentRow[];
  sourceDocumentRevisions?: DocumentRevisionRow[];
  targetDocumentRevisions?: DocumentRevisionRow[];
  sourceAttachments?: IssueAttachmentRow[];
  targetAttachments?: IssueAttachmentRow[];
  targetAgents: AgentRow[];
  targetProjects: ProjectRow[];
  targetProjectWorkspaces: ProjectWorkspaceRow[];
  targetGoals: GoalRow[];
  importProjectIds?: Iterable<string>;
  projectIdOverrides?: Record<string, string | null | undefined>;
}): WorktreeMergePlan {
  const targetIssuesById = new Map(input.targetIssues.map((issue) => [issue.id, issue]));
  const targetCommentIds = new Set(input.targetComments.map((comment) => comment.id));
  const targetAgentIds = new Set(input.targetAgents.map((agent) => agent.id));
  const targetProjectIds = new Set(input.targetProjects.map((project) => project.id));
  const targetProjectsById = new Map(input.targetProjects.map((project) => [project.id, project]));
  const targetProjectWorkspaceIds = new Set(input.targetProjectWorkspaces.map((workspace) => workspace.id));
  const targetGoalIds = new Set(input.targetGoals.map((goal) => goal.id));
  const sourceProjectsById = new Map((input.sourceProjects ?? []).map((project) => [project.id, project]));
  const sourceProjectWorkspaces = input.sourceProjectWorkspaces ?? [];
  const sourceProjectWorkspacesByProjectId = groupBy(sourceProjectWorkspaces, (workspace) => workspace.projectId);
  const importProjectIds = new Set(input.importProjectIds ?? []);
  const scopes = new Set(input.scopes);

  const adjustmentCounts: Record<ImportAdjustment, number> = {
    clear_assignee_agent: 0,
    clear_project: 0,
    clear_project_workspace: 0,
    clear_goal: 0,
    clear_author_agent: 0,
    coerce_in_progress_to_todo: 0,
    clear_document_agent: 0,
    clear_document_revision_agent: 0,
    clear_attachment_agent: 0,
  };

  const projectImports: PlannedProjectImport[] = [];
  for (const projectId of importProjectIds) {
    if (targetProjectIds.has(projectId)) continue;
    const sourceProject = sourceProjectsById.get(projectId);
    if (!sourceProject) continue;
    projectImports.push({
      source: sourceProject,
      targetLeadAgentId:
        sourceProject.leadAgentId && targetAgentIds.has(sourceProject.leadAgentId)
          ? sourceProject.leadAgentId
          : null,
      targetGoalId:
        sourceProject.goalId && targetGoalIds.has(sourceProject.goalId)
          ? sourceProject.goalId
          : null,
      workspaces: [...(sourceProjectWorkspacesByProjectId.get(projectId) ?? [])].sort((left, right) => {
        const primaryDelta = Number(right.isPrimary) - Number(left.isPrimary);
        if (primaryDelta !== 0) return primaryDelta;
        const createdDelta = left.createdAt.getTime() - right.createdAt.getTime();
        if (createdDelta !== 0) return createdDelta;
        return left.id.localeCompare(right.id);
      }),
    });
  }
  const importedProjectWorkspaceIds = new Set(
    projectImports.flatMap((project) => project.workspaces.map((workspace) => workspace.id)),
  );

  const issuePlans: Array<PlannedIssueInsert | PlannedIssueSkip> = [];
  let nextPreviewIssueNumber = input.previewIssueCounterStart;
  for (const issue of sortIssuesForImport(input.sourceIssues)) {
    const existing = targetIssuesById.get(issue.id);
    if (existing) {
      issuePlans.push({
        source: issue,
        action: "skip_existing",
        driftKeys: compareIssueCoreFields(issue, existing),
      });
      continue;
    }

    nextPreviewIssueNumber += 1;
    const adjustments: ImportAdjustment[] = [];
    const targetAssigneeAgentId =
      issue.assigneeAgentId && targetAgentIds.has(issue.assigneeAgentId) ? issue.assigneeAgentId : null;
    if (issue.assigneeAgentId && !targetAssigneeAgentId) {
      adjustments.push("clear_assignee_agent");
      incrementAdjustment(adjustmentCounts, "clear_assignee_agent");
    }

    const targetCreatedByAgentId =
      issue.createdByAgentId && targetAgentIds.has(issue.createdByAgentId) ? issue.createdByAgentId : null;

    let targetProjectId =
      issue.projectId && targetProjectIds.has(issue.projectId) ? issue.projectId : null;
    let projectResolution: PlannedIssueInsert["projectResolution"] = targetProjectId ? "preserved" : "cleared";
    let mappedProjectName: string | null = null;
    const overrideProjectId =
      issue.projectId && input.projectIdOverrides
        ? input.projectIdOverrides[issue.projectId] ?? null
        : null;
    if (!targetProjectId && overrideProjectId && targetProjectIds.has(overrideProjectId)) {
      targetProjectId = overrideProjectId;
      projectResolution = "mapped";
      mappedProjectName = targetProjectsById.get(overrideProjectId)?.name ?? null;
    }
    if (!targetProjectId && issue.projectId && importProjectIds.has(issue.projectId)) {
      const sourceProject = sourceProjectsById.get(issue.projectId);
      if (sourceProject) {
        targetProjectId = sourceProject.id;
        projectResolution = "imported";
        mappedProjectName = sourceProject.name;
      }
    }
    if (issue.projectId && !targetProjectId) {
      adjustments.push("clear_project");
      incrementAdjustment(adjustmentCounts, "clear_project");
    }

    const targetProjectWorkspaceId =
      targetProjectId
      && targetProjectId === issue.projectId
      && issue.projectWorkspaceId
      && (targetProjectWorkspaceIds.has(issue.projectWorkspaceId)
        || importedProjectWorkspaceIds.has(issue.projectWorkspaceId))
        ? issue.projectWorkspaceId
        : null;
    if (issue.projectWorkspaceId && !targetProjectWorkspaceId) {
      adjustments.push("clear_project_workspace");
      incrementAdjustment(adjustmentCounts, "clear_project_workspace");
    }

    const targetGoalId =
      issue.goalId && targetGoalIds.has(issue.goalId) ? issue.goalId : null;
    if (issue.goalId && !targetGoalId) {
      adjustments.push("clear_goal");
      incrementAdjustment(adjustmentCounts, "clear_goal");
    }

    let targetStatus = issue.status;
    if (
      targetStatus === "in_progress"
      && !targetAssigneeAgentId
      && !(issue.assigneeUserId && issue.assigneeUserId.trim().length > 0)
    ) {
      targetStatus = "todo";
      adjustments.push("coerce_in_progress_to_todo");
      incrementAdjustment(adjustmentCounts, "coerce_in_progress_to_todo");
    }

    issuePlans.push({
      source: issue,
      action: "insert",
      previewIssueNumber: nextPreviewIssueNumber,
      previewIdentifier: `${input.issuePrefix}-${nextPreviewIssueNumber}`,
      targetStatus,
      targetAssigneeAgentId,
      targetCreatedByAgentId,
      targetProjectId,
      targetProjectWorkspaceId,
      targetGoalId,
      projectResolution,
      mappedProjectName,
      adjustments,
    });
  }

  const issueIdsAvailableAfterImport = new Set<string>([
    ...input.targetIssues.map((issue) => issue.id),
    ...issuePlans.filter((plan): plan is PlannedIssueInsert => plan.action === "insert").map((plan) => plan.source.id),
  ]);

  const commentPlans: Array<PlannedCommentInsert | PlannedCommentSkip> = [];
  if (scopes.has("comments")) {
    const sortedComments = [...input.sourceComments].sort((left, right) => {
      const createdDelta = left.createdAt.getTime() - right.createdAt.getTime();
      if (createdDelta !== 0) return createdDelta;
      return left.id.localeCompare(right.id);
    });

    for (const comment of sortedComments) {
      if (targetCommentIds.has(comment.id)) {
        commentPlans.push({ source: comment, action: "skip_existing" });
        continue;
      }
      if (!issueIdsAvailableAfterImport.has(comment.issueId)) {
        commentPlans.push({ source: comment, action: "skip_missing_parent" });
        continue;
      }

      const adjustments: ImportAdjustment[] = [];
      const targetAuthorAgentId =
        comment.authorAgentId && targetAgentIds.has(comment.authorAgentId) ? comment.authorAgentId : null;
      if (comment.authorAgentId && !targetAuthorAgentId) {
        adjustments.push("clear_author_agent");
        incrementAdjustment(adjustmentCounts, "clear_author_agent");
      }

      commentPlans.push({
        source: comment,
        action: "insert",
        targetAuthorAgentId,
        adjustments,
      });
    }
  }

  const sourceDocuments = input.sourceDocuments ?? [];
  const targetDocuments = input.targetDocuments ?? [];
  const sourceDocumentRevisions = input.sourceDocumentRevisions ?? [];
  const targetDocumentRevisions = input.targetDocumentRevisions ?? [];

  const targetDocumentsById = new Map(targetDocuments.map((document) => [document.documentId, document]));
  const targetDocumentsByIssueKey = new Map(targetDocuments.map((document) => [`${document.issueId}:${document.key}`, document]));
  const sourceRevisionsByDocumentId = groupBy(sourceDocumentRevisions, (revision) => revision.documentId);
  const targetRevisionsByDocumentId = groupBy(targetDocumentRevisions, (revision) => revision.documentId);
  const commentIdsAvailableAfterImport = new Set<string>([
    ...input.targetComments.map((comment) => comment.id),
    ...commentPlans.filter((plan): plan is PlannedCommentInsert => plan.action === "insert").map((plan) => plan.source.id),
  ]);

  const documentPlans: Array<PlannedIssueDocumentInsert | PlannedIssueDocumentMerge | PlannedIssueDocumentSkip> = [];
  for (const document of sortDocumentRows(sourceDocuments)) {
    if (!issueIdsAvailableAfterImport.has(document.issueId)) {
      documentPlans.push({ source: document, action: "skip_missing_parent" });
      continue;
    }

    const existingDocument = targetDocumentsById.get(document.documentId);
    const conflictingIssueKeyDocument = targetDocumentsByIssueKey.get(`${document.issueId}:${document.key}`);
    if (!existingDocument && conflictingIssueKeyDocument && conflictingIssueKeyDocument.documentId !== document.documentId) {
      documentPlans.push({ source: document, action: "skip_conflicting_key" });
      continue;
    }

    const adjustments: ImportAdjustment[] = [];
    const targetCreatedByAgentId =
      document.createdByAgentId && targetAgentIds.has(document.createdByAgentId) ? document.createdByAgentId : null;
    const targetUpdatedByAgentId =
      document.updatedByAgentId && targetAgentIds.has(document.updatedByAgentId) ? document.updatedByAgentId : null;
    if (
      (document.createdByAgentId && !targetCreatedByAgentId)
      || (document.updatedByAgentId && !targetUpdatedByAgentId)
    ) {
      adjustments.push("clear_document_agent");
      incrementAdjustment(adjustmentCounts, "clear_document_agent");
    }

    const sourceRevisions = sortDocumentRevisions(sourceRevisionsByDocumentId.get(document.documentId) ?? []);
    const targetRevisions = sortDocumentRevisions(targetRevisionsByDocumentId.get(document.documentId) ?? []);
    const existingRevisionIds = new Set(targetRevisions.map((revision) => revision.id));
    const usedRevisionNumbers = new Set(targetRevisions.map((revision) => revision.revisionNumber));
    let nextRevisionNumber = targetRevisions.reduce(
      (maxValue, revision) => Math.max(maxValue, revision.revisionNumber),
      0,
    ) + 1;

    const targetRevisionNumberById = new Map<string, number>(
      targetRevisions.map((revision) => [revision.id, revision.revisionNumber]),
    );
    const revisionsToInsert: PlannedDocumentRevisionInsert[] = [];

    for (const revision of sourceRevisions) {
      if (existingRevisionIds.has(revision.id)) continue;
      let targetRevisionNumber = revision.revisionNumber;
      if (usedRevisionNumbers.has(targetRevisionNumber)) {
        while (usedRevisionNumbers.has(nextRevisionNumber)) {
          nextRevisionNumber += 1;
        }
        targetRevisionNumber = nextRevisionNumber;
        nextRevisionNumber += 1;
      }
      usedRevisionNumbers.add(targetRevisionNumber);
      targetRevisionNumberById.set(revision.id, targetRevisionNumber);

      const revisionAdjustments: ImportAdjustment[] = [];
      const targetCreatedByAgentId =
        revision.createdByAgentId && targetAgentIds.has(revision.createdByAgentId) ? revision.createdByAgentId : null;
      if (revision.createdByAgentId && !targetCreatedByAgentId) {
        revisionAdjustments.push("clear_document_revision_agent");
        incrementAdjustment(adjustmentCounts, "clear_document_revision_agent");
      }

      revisionsToInsert.push({
        source: revision,
        targetRevisionNumber,
        targetCreatedByAgentId,
        adjustments: revisionAdjustments,
      });
    }

    const latestRevisionId = document.latestRevisionId ?? existingDocument?.latestRevisionId ?? null;
    const latestRevisionNumber =
      (latestRevisionId ? targetRevisionNumberById.get(latestRevisionId) : undefined)
      ?? document.latestRevisionNumber
      ?? existingDocument?.latestRevisionNumber
      ?? 0;

    if (!existingDocument) {
      documentPlans.push({
        source: document,
        action: "insert",
        targetCreatedByAgentId,
        targetUpdatedByAgentId,
        latestRevisionId,
        latestRevisionNumber,
        revisionsToInsert,
        adjustments,
      });
      continue;
    }

    const documentAlreadyMatches =
      existingDocument.key === document.key
      && existingDocument.title === document.title
      && existingDocument.format === document.format
      && existingDocument.latestBody === document.latestBody
      && (existingDocument.latestRevisionId ?? null) === latestRevisionId
      && existingDocument.latestRevisionNumber === latestRevisionNumber
      && (existingDocument.updatedByAgentId ?? null) === targetUpdatedByAgentId
      && (existingDocument.updatedByUserId ?? null) === (document.updatedByUserId ?? null)
      && sameDate(existingDocument.documentUpdatedAt, document.documentUpdatedAt)
      && sameDate(existingDocument.linkUpdatedAt, document.linkUpdatedAt)
      && revisionsToInsert.length === 0;

    if (documentAlreadyMatches) {
      documentPlans.push({ source: document, action: "skip_existing" });
      continue;
    }

    documentPlans.push({
      source: document,
      action: "merge_existing",
      targetCreatedByAgentId,
      targetUpdatedByAgentId,
      latestRevisionId,
      latestRevisionNumber,
      revisionsToInsert,
      adjustments,
    });
  }

  const sourceAttachments = input.sourceAttachments ?? [];
  const targetAttachmentIds = new Set((input.targetAttachments ?? []).map((attachment) => attachment.id));
  const attachmentPlans: Array<PlannedAttachmentInsert | PlannedAttachmentSkip> = [];
  for (const attachment of sortAttachments(sourceAttachments)) {
    if (targetAttachmentIds.has(attachment.id)) {
      attachmentPlans.push({ source: attachment, action: "skip_existing" });
      continue;
    }
    if (!issueIdsAvailableAfterImport.has(attachment.issueId)) {
      attachmentPlans.push({ source: attachment, action: "skip_missing_parent" });
      continue;
    }

    const adjustments: ImportAdjustment[] = [];
    const targetCreatedByAgentId =
      attachment.createdByAgentId && targetAgentIds.has(attachment.createdByAgentId)
        ? attachment.createdByAgentId
        : null;
    if (attachment.createdByAgentId && !targetCreatedByAgentId) {
      adjustments.push("clear_attachment_agent");
      incrementAdjustment(adjustmentCounts, "clear_attachment_agent");
    }

    attachmentPlans.push({
      source: attachment,
      action: "insert",
      targetIssueCommentId:
        attachment.issueCommentId && commentIdsAvailableAfterImport.has(attachment.issueCommentId)
          ? attachment.issueCommentId
          : null,
      targetCreatedByAgentId,
      adjustments,
    });
  }

  const counts = {
    projectsToImport: projectImports.length,
    issuesToInsert: issuePlans.filter((plan) => plan.action === "insert").length,
    issuesExisting: issuePlans.filter((plan) => plan.action === "skip_existing").length,
    issueDrift: issuePlans.filter((plan) => plan.action === "skip_existing" && plan.driftKeys.length > 0).length,
    commentsToInsert: commentPlans.filter((plan) => plan.action === "insert").length,
    commentsExisting: commentPlans.filter((plan) => plan.action === "skip_existing").length,
    commentsMissingParent: commentPlans.filter((plan) => plan.action === "skip_missing_parent").length,
    documentsToInsert: documentPlans.filter((plan) => plan.action === "insert").length,
    documentsToMerge: documentPlans.filter((plan) => plan.action === "merge_existing").length,
    documentsExisting: documentPlans.filter((plan) => plan.action === "skip_existing").length,
    documentsConflictingKey: documentPlans.filter((plan) => plan.action === "skip_conflicting_key").length,
    documentsMissingParent: documentPlans.filter((plan) => plan.action === "skip_missing_parent").length,
    documentRevisionsToInsert: documentPlans.reduce(
      (sum, plan) =>
        sum + (plan.action === "insert" || plan.action === "merge_existing" ? plan.revisionsToInsert.length : 0),
      0,
    ),
    attachmentsToInsert: attachmentPlans.filter((plan) => plan.action === "insert").length,
    attachmentsExisting: attachmentPlans.filter((plan) => plan.action === "skip_existing").length,
    attachmentsMissingParent: attachmentPlans.filter((plan) => plan.action === "skip_missing_parent").length,
  };

  return {
    companyId: input.companyId,
    companyName: input.companyName,
    issuePrefix: input.issuePrefix,
    previewIssueCounterStart: input.previewIssueCounterStart,
    scopes: input.scopes,
    projectImports,
    issuePlans,
    commentPlans,
    documentPlans,
    attachmentPlans,
    counts,
    adjustments: adjustmentCounts,
  };
}
