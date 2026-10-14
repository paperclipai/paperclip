/** A proxy or restarting server answered an API request without usable JSON. */
export class ApiUnavailableError extends Error {
  constructor(public readonly status: number) {
    super("Paperclip is temporarily unavailable. Please try again in a moment.");
    this.name = "ApiUnavailableError";
  }
}

export function isTemporaryApiError(error: unknown): boolean {
  if (error instanceof ApiUnavailableError) return true;
  if (!(error instanceof Error)) return false;
  if ("status" in error && [502, 503, 504].includes(error.status as number)) return true;
  // Fetch uses different network-failure messages across browsers. Do not
  // classify arbitrary TypeErrors (programming bugs) or aborts as outages.
  return error instanceof TypeError && /fetch|network|load failed/i.test(error.message);
}

export async function readApiJson<T = unknown>(response: Response): Promise<T> {
  try {
    return await response.json() as T;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // An HTML fallback can have status 200 during a deployment. Never expose
    // its parser error or treat it as a successful, empty API response.
    if (response.ok || response.status >= 500) throw new ApiUnavailableError(response.status);
    // Preserve HTTP/auth error handling even when a 4xx response has no JSON.
    return null as T;
  }
}
