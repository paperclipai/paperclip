export class AntigravityRuntimeUnavailableError extends Error {
  readonly code = "ANTIGRAVITY_RUNTIME_UNAVAILABLE";
  constructor() {
    super("This server does not have the current Google Antigravity runtime.");
    this.name = "AntigravityRuntimeUnavailableError";
  }
}
