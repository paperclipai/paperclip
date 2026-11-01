export function resolveExternalTestDatabaseUrl(name: string, value = process.env[name]): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    const url = new URL(value);
    const database = decodeURIComponent(url.pathname.slice(1));
    if (['postgres:', 'postgresql:'].includes(url.protocol)
      && /^[a-zA-Z0-9_]+_test$/.test(database)
      && !['database', 'dbname', 'options'].some(key => url.searchParams.has(key))) return value;
  } catch {}
  throw new Error(`${name} must name a dedicated PostgreSQL database ending in _test, without database or options overrides`);
}
