import type { AcpSessionRecord, AcpSessionStore } from "acpx/runtime";

/**
 * ACPX carries the provider launch environment as a session option
 * (`acpx.session_options.env`) and persists the whole session record to
 * `<stateDir>/sessions/<acpxRecordId>.json`. The engine passes this run's live
 * credentials in that environment, so an unfiltered store writes every bound
 * secret to disk in plaintext, once per session, for the lifetime of the record.
 *
 * On a single-host install every agent seat runs as the same OS account, so file
 * modes buy nothing: one seat can read another seat's session file with no
 * privilege escalation, including seats that were never granted the credential.
 * The only durable fix is to keep the value out of the file.
 *
 * The launch environment is run-owned state, not session state. The engine
 * already re-injects it from `prepared.env` on every `load()`, so a record with
 * no persisted `env` resumes exactly like one that has it.
 *
 * Strip rather than redact. A record that keeps the key names with placeholder
 * values would export `SOME_TOKEN=***REDACTED***` into a provider child for any
 * reader that does not go through `load()` (the `acpx` CLI against the same
 * state dir, for instance), turning a credential leak into an undiagnosable
 * auth failure. Absent is both safer and honest.
 */
export function stripPersistedLaunchEnv(record: AcpSessionRecord): AcpSessionRecord {
  const sessionOptions = record.acpx?.session_options;
  if (!sessionOptions || sessionOptions.env === undefined) return record;

  // Copy every level this touches. ACPX keeps using the record it handed to
  // `save()` after the call resolves — the in-memory session options must keep
  // the live environment, or the next turn of this session launches the
  // provider with no credentials.
  const { env: _persistedEnv, ...sessionOptionsWithoutEnv } = sessionOptions;
  const acpx = { ...record.acpx };
  if (Object.keys(sessionOptionsWithoutEnv).length > 0) {
    acpx.session_options = sessionOptionsWithoutEnv;
  } else {
    // `env` was the only option. Leaving `session_options: {}` behind would
    // persist a shape ACPX never writes itself (`hasStoredSessionOptions`
    // deletes the key when nothing is left), so drop it.
    delete acpx.session_options;
  }
  return { ...record, acpx };
}

/**
 * Wrap the persisted ACPX session store so conversation state is durable but
 * this run's credentials are not.
 *
 * - `load()` returns the stored record with `session_options.env` replaced by
 *   this run's launch environment. ACPX resumes from the stored session options
 *   rather than the options passed to `ensureSession`, so the provider has to be
 *   relaunched with current credentials and scratch paths, not a previous run's.
 * - `save()` writes the record without `session_options.env` at all.
 */
export function createCredentialSafeSessionStore(input: {
  persisted: AcpSessionStore;
  launchEnv: Record<string, string>;
}): AcpSessionStore {
  const { persisted, launchEnv } = input;
  return {
    async load(id) {
      const record = await persisted.load(id);
      if (!record) return undefined;
      return {
        ...record,
        acpx: {
          ...record.acpx,
          session_options: {
            ...record.acpx?.session_options,
            env: { ...launchEnv },
          },
        },
      };
    },
    save: (record) => persisted.save(stripPersistedLaunchEnv(record)),
  };
}
