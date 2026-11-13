export const REPOSITORY_CATALOG_UNAVAILABLE_CODE = "repository_catalog_unavailable";

export class RepositoryCatalogUnavailableError extends Error {
  readonly code = REPOSITORY_CATALOG_UNAVAILABLE_CODE;

  constructor(readonly retryAt?: number) {
    super("The repository catalog is temporarily unavailable. Paperclip will retry before starting agent work.");
    this.name = "RepositoryCatalogUnavailableError";
  }
}

export function findRepositoryCatalogUnavailableError(error: unknown): RepositoryCatalogUnavailableError | null {
  for (let current = error, depth = 0; current && depth < 4; current = (current as { cause?: unknown }).cause, depth++) {
    if (current instanceof RepositoryCatalogUnavailableError) return current;
  }
  return null;
}
