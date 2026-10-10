// Resolves the Sentry DSN for each component from the process environment.
//
// Precedence: a specific variable always wins for its own component.
// `SENTRY_DSN` supplies a component that has no specific value set.
// An empty string counts as absent for every variable, so a specific
// variable set to `""` still falls back to `SENTRY_DSN`.
//
// To add a DSN for a new component, add a field to `SentryDsns`, add a
// variable named with the shared `SENTRY_DSN_` prefix, and resolve it with
// `normalize` the same way `frontend` and `backend` resolve here.

export interface SentryDsns {
  frontend: string | null;
  backend: string | null;
  legacyFallbackUsed: boolean;
}

function normalize(value: string | undefined): string | null {
  return value ? value : null;
}

export function resolveSentryDsns(env: NodeJS.ProcessEnv = process.env): SentryDsns {
  const legacy = normalize(env.SENTRY_DSN);
  const specificFrontend = normalize(env.SENTRY_DSN_FRONTEND);
  const specificBackend = normalize(env.SENTRY_DSN_BACKEND);

  const frontend = specificFrontend ?? legacy;
  const backend = specificBackend ?? legacy;
  const legacyFallbackUsed = (specificFrontend === null || specificBackend === null) && legacy !== null;

  return { frontend, backend, legacyFallbackUsed };
}
