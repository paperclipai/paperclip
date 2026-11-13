type SlackEndpoint = { id: string; connectionId: string };

export async function prepareSlackEndpoints<T>(
  endpoints: readonly SlackEndpoint[],
  resolve: (endpoint: SlackEndpoint) => Promise<T[]>,
): Promise<T[]> {
  const contributions: T[] = [];
  for (let offset = 0; offset < endpoints.length; offset += 2) {
    const results = await Promise.allSettled(
      endpoints.slice(offset, offset + 2).map(async endpoint => resolve(endpoint)),
    );
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
    }
    for (const result of results) {
      if (result.status === "fulfilled") contributions.push(...result.value);
    }
  }
  return contributions;
}
