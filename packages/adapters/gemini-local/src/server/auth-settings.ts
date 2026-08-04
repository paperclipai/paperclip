import path from "node:path";

/**
 * Gemini refuses headless runs unless an auth method is persisted in
 * `$HOME/.gemini/settings.json` ("Invalid auth method selected."); the
 * `GEMINI_DEFAULT_AUTH_TYPE` env var alone does not satisfy it. With a managed
 * HOME the runtime root replaces the image home, so anything baked into the
 * image is invisible and the selector has to be written per run.
 *
 * Whether to write it depends on one question: will an api key actually be
 * readable by the agent process? That is not reliably knowable on the host.
 * The adapter's run env misses keys that a sandbox provider injects directly
 * into the sandbox (the Kubernetes provider copies `process.env` values named
 * by its per-adapter `envKeys` into the pod), while the host `process.env`
 * carries keys that never reach a remote target at all. Guessing from either
 * one is wrong somewhere: guess low and headless Gemini hangs with no auth
 * method selected, guess high and it starts with an auth method whose
 * credential is absent.
 *
 * So do not guess. This command runs inside the target, so it tests the
 * credential where the agent will actually read it, at the moment it matters.
 *
 * Writes no key bytes: only the selector. An existing settings.json
 * (user-shipped via the workspace) is left untouched.
 */
export function buildGeminiAuthSelectorCommand(managedHomeDir: string): string {
  const settingsPath = path.posix.join(managedHomeDir, ".gemini", "settings.json");
  const settingsJson = JSON.stringify({
    selectedAuthType: "gemini-api-key",
    security: { auth: { selectedType: "gemini-api-key" } },
  });
  const quotedDir = JSON.stringify(path.posix.dirname(settingsPath));
  const quotedPath = JSON.stringify(settingsPath);
  const quotedJson = JSON.stringify(settingsJson);
  // Skip when the file already exists, then skip when neither key is set in
  // the target's own environment, otherwise write the selector. Every branch
  // exits 0, so the command never fails a run over an absent credential.
  return (
    `mkdir -p ${quotedDir} && { [ -f ${quotedPath} ] || ` +
    `[ -z "\${GEMINI_API_KEY:-}\${GOOGLE_API_KEY:-}" ] || ` +
    `printf '%s' ${quotedJson} > ${quotedPath}; }`
  );
}
