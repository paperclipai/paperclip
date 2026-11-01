export function takeCompanyWorkBatch<T extends { companyId: string }>(
  ordered: readonly T[],
  limit: number,
  afterCompany: string | null = null,
): { entries: T[]; lastCompany: string | null } {
  const grouped = new Map<string, T[]>();
  for (const entry of ordered) {
    const group = grouped.get(entry.companyId);
    if (group) group.push(entry); else grouped.set(entry.companyId, [entry]);
  }
  const companies = [...grouped.keys()].sort();
  const next = afterCompany === null ? 0 : companies.findIndex(id => id > afterCompany);
  const start = next < 0 ? 0 : next;
  const rotation = [...companies.slice(start), ...companies.slice(0, start)];
  const entries: T[] = [];
  let lastCompany = afterCompany;
  for (let round = 0; entries.length < limit; round++) {
    let added = false;
    for (const companyId of rotation) {
      const entry = grouped.get(companyId)![round];
      if (!entry) continue;
      entries.push(entry); lastCompany = companyId; added = true;
      if (entries.length === limit) break;
    }
    if (!added) break;
  }
  return { entries, lastCompany };
}
