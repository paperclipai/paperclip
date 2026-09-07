export type HeaderSource = {
  header(name: string): string | undefined;
};

/**
 * Adapt the Web Request header collection to the narrow header source used by
 * Paperclip credential resolvers. The returned object is immutable so callers
 * cannot rewrite authentication headers after resolution begins.
 */
export function toHeaderSource(request: Request): HeaderSource {
  const headers = new Headers(request.headers);
  return Object.freeze({
    header(name: string) {
      return headers.get(name) ?? undefined;
    },
  });
}
