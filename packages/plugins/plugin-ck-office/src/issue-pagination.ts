export interface IssuePageClient<T> {
  list(params: {
    companyId: string;
    limit?: number;
    offset?: number;
    status?: string;
  }): Promise<T[]>;
}

export async function listAllCompanyIssues<T>(
  client: IssuePageClient<T>,
  companyId: string,
  options: { pageSize?: number; status?: string } = {},
): Promise<T[]> {
  const pageSize = Math.max(1, Math.min(500, options.pageSize ?? 200));
  const rows: T[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await client.list({
      companyId,
      limit: pageSize,
      offset,
      ...(options.status ? { status: options.status } : {}),
    });
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}
