// ---------------------------------------------------------------------------
// Custom Errors
// ---------------------------------------------------------------------------

/**
 * Error thrown when an external provider (e.g., LLM API) indicates that
 * a rate limit or other usage-based limit has been exceeded.
 */
export class ProviderLimitExceededError extends Error {
  name = "ProviderLimitExceededError";

  constructor(
    public provider: string,
    public message: string = `Rate limit exceeded for provider: ${provider}`,
    public retryAfterSeconds?: number,
    /** Model-level route identifier (e.g., "gemini_local:gemini-2.5-flash"). */
    public routeId?: string,
  ) {
    super(message);
    // Set the prototype explicitly to ensure correct inheritance when transpiled
    Object.setPrototypeOf(this, ProviderLimitExceededError.prototype);
  }
}
