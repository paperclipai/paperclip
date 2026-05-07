export interface IssuesListApi {
  list(input: { companyId: string; originKind: string; originId: string; limit?: number }): Promise<Array<{ id: string }>>;
}

export async function findIssueByOrigin(api: IssuesListApi, companyId: string, originKind: string, originId: string): Promise<string | null> {
  const results = await api.list({ companyId, originKind, originId, limit: 1 });
  return results[0]?.id ?? null;
}
