import { and, asc, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";
import { issueWorkflowService } from "./issue-workflows.js";

type BrokenWorkflowRoot = {
  rootIssueId: string;
  companyId: string;
  identifier: string | null;
  title: string;
  templateKey: string;
  missingDependencyRelationCount: number;
  laneStatusDriftCount: number;
  dependencyDriftRoles: string[];
  statusDriftRoles: string[];
};

type WorkflowIntegrityInspection = {
  brokenWorkflowRoots: {
    count: number;
    roots: BrokenWorkflowRoot[];
  };
};

type WorkflowIntegritySummary = {
  workflowRootsRepaired: number;
  dependencyRelationsRepaired: number;
  laneStatusesNormalized: number;
  repairedRootIssueIds: string[];
};

export function workflowIntegrityService(db: Db) {
  const workflows = issueWorkflowService(db);

  function countChangedDependencyRelations(input: {
    blockerIssueIds: string[];
    existingBlockerIssueIds: string[];
  }) {
    const expected = new Set(input.blockerIssueIds);
    const existing = new Set(input.existingBlockerIssueIds);
    let changedRelations = 0;
    for (const blockerIssueId of expected) {
      if (!existing.has(blockerIssueId)) {
        changedRelations += 1;
      }
    }
    for (const blockerIssueId of existing) {
      if (!expected.has(blockerIssueId)) {
        changedRelations += 1;
      }
    }
    return changedRelations;
  }

  async function listWorkflowRoots() {
    return db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        identifier: issues.identifier,
        title: issues.title,
        workflowTemplateKey: issues.workflowTemplateKey,
      })
      .from(issues)
      .where(
        and(
          isNull(issues.workflowLaneRole),
          isNull(issues.hiddenAt),
          isNotNull(issues.workflowTemplateKey),
        ),
      )
      .orderBy(asc(issues.createdAt), asc(issues.id));
  }

  async function inspectRoot(root: Awaited<ReturnType<typeof listWorkflowRoots>>[number]): Promise<BrokenWorkflowRoot | null> {
    const inspection = await workflows.inspectWorkflowTemplateGraph(root.id);
    if (!inspection) return null;

    const missingDependencyRelationCount = inspection.relationUpdates.reduce(
      (total, relationUpdate) =>
        total + countChangedDependencyRelations(relationUpdate),
      0,
    );
    const laneStatusDriftCount = inspection.statusUpdates.length;
    if (missingDependencyRelationCount === 0 && laneStatusDriftCount === 0) {
      return null;
    }

    return {
      rootIssueId: root.id,
      companyId: root.companyId,
      identifier: root.identifier,
      title: root.title,
      templateKey: inspection.templateKey,
      missingDependencyRelationCount,
      laneStatusDriftCount,
      dependencyDriftRoles: inspection.relationUpdates.map((update) => update.laneRole),
      statusDriftRoles: inspection.statusUpdates.map((update) => update.laneRole),
    };
  }

  return {
    async inspect(): Promise<WorkflowIntegrityInspection> {
      const roots = await listWorkflowRoots();
      const brokenWorkflowRoots = (
        await Promise.all(roots.map(async (root) => await inspectRoot(root)))
      ).filter((root): root is BrokenWorkflowRoot => Boolean(root));

      return {
        brokenWorkflowRoots: {
          count: brokenWorkflowRoots.length,
          roots: brokenWorkflowRoots,
        },
      };
    },

    async reconcileAll(): Promise<WorkflowIntegritySummary> {
      const roots = await listWorkflowRoots();
      let workflowRootsRepaired = 0;
      let dependencyRelationsRepaired = 0;
      let laneStatusesNormalized = 0;
      const repairedRootIssueIds: string[] = [];

      for (const root of roots) {
        const inspection = await inspectRoot(root);
        if (!inspection) continue;

        const repaired = await workflows.reconcileWorkflowTemplateGraph(root.id);
        if (!repaired?.repaired) continue;

        workflowRootsRepaired += 1;
        dependencyRelationsRepaired += repaired.relationUpdates.reduce(
          (total, relationUpdate) => total + countChangedDependencyRelations(relationUpdate),
          0,
        );
        laneStatusesNormalized += repaired.statusUpdates.length;
        repairedRootIssueIds.push(root.id);
      }

      return {
        workflowRootsRepaired,
        dependencyRelationsRepaired,
        laneStatusesNormalized,
        repairedRootIssueIds,
      };
    },
  };
}
