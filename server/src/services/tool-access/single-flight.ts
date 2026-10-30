

export async function singleFlight<T>(
  flights: Map<string, Promise<unknown>>,
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const existing = flights.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const pending = operation();
  flights.set(key, pending);
  try {
    return await pending;
  } finally {
    if (flights.get(key) === pending) flights.delete(key);
  }
}
