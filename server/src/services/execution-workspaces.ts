    list: async (companyId: string, filters?: {
      projectId?: string;
      projectWorkspaceId?: string;
      issueId?: string;
      status?: string;
      reuseEligible?: boolean;
    }) => {
      if (filters?.issueId) {
        const sourceCondition = [eq(executionWorkspaces.sourceIssueId, filters.issueId)];
        const rows = await db
          .select()
          .from(executionWorkspaces)
          .where(and(...sourceCondition))
          .orderBy(desc(executionWorkspaces.lastUsedAt), desc(executionWorkspaces.createdAt));
        const runtimeServicesByWorkspaceId = await loadEffectiveRuntimeServicesByExecutionWorkspace(db, companyId, rows);
        return rows.map((row) =>
          toExecutionWorkspace(
            row,
            (runtimeServicesByWorkspaceId.get(row.id) ?? []).map(toRuntimeService),
          ),
        );
      } else {
        const conditions = buildListConditions(companyId, filters);
        const rows = await db
          .select()
          .from(executionWorkspaces)
          .where(and(...conditions))
          .orderBy(desc(executionWorkspaces.lastUsedAt), desc(executionWorkspaces.createdAt));
        const runtimeServicesByWorkspaceId = await loadEffectiveRuntimeServicesByExecutionWorkspace(db, companyId, rows);
        return rows.map((row) =>
          toExecutionWorkspace(
            row,
            (runtimeServicesByWorkspaceId.get(row.id) ?? []).map(toRuntimeService),
          ),
        );
      }
    },
