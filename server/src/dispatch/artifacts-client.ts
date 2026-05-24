/**
 * Phase 2 Task 2.4 -- agent-fs artifact client seam.
 *
 * The dispatch layer mirrors prior-stage video artifacts into a worker's
 * per-run sandbox before spawning. Reading from agent-fs is factored
 * behind this interface so unit tests can inject a fake without spinning
 * up real HTTP. The real production implementation is
 * `httpArtifactsClient`, which hits the agent-fs REST surface added in
 * Task 2.3.
 *
 * This client handles JSON artifacts only -- the agent-fs JSON route
 * parses the body and returns it as a structured value. Binary artifacts
 * (`.mp4`, `.srt`, `caption_text.txt`, etc.) are written via the binary
 * route added in Phase 3.5 Step 1 and read by ceo-chat over HTTP (see
 * `services/ceo-chat/src/video-ad/artifact-fetcher.ts`); they do NOT
 * flow through this client.
 *
 * A `null` return means the artifact does not exist (or the agent-fs
 * call returned a non-200 we treat as missing); callers decide whether
 * that is fatal.
 *
 * The HTTP request shape:
 *   GET <baseUrl>/artifacts/<requestId>/<stage>/<filename>
 *   Authorization: Bearer <token>
 *
 * See docs/superpowers/plans/2026-05-23-video-guild-implementation.md
 * Task 2.4 + Task 2.3.
 */

/**
 * Fetches a single artifact JSON blob from agent-fs (or a fake in
 * tests). Returns the parsed body, or null when the artifact is
 * missing.
 */
export interface ArtifactsClient {
  fetchArtifact(
    requestId: string,
    stage: string,
    filename: string,
  ): Promise<unknown | null>;
}

export interface HttpArtifactsClientEnv {
  /** Base URL for agent-fs, e.g. `http://agent-fs:7100`. No trailing slash. */
  url: string;
  /** Bearer token for the dispatcher's agent-fs credentials. */
  token: string;
}

/**
 * Production implementation. Wraps `fetch` against the agent-fs
 * Task 2.3 route. A 404 resolves to `null` (artifact truly missing;
 * the dispatcher surfaces this as a soft degraded-path warning). Any
 * other non-2xx (401, 403, 5xx, etc.) throws with status + URL in the
 * message so the dispatcher's try/catch surfaces it as a louder
 * operational warning rather than silently degrading. Network errors
 * propagate naturally for the same reason.
 */
export function httpArtifactsClient(env: HttpArtifactsClientEnv): ArtifactsClient {
  const base = env.url.replace(/\/+$/, "");
  return {
    async fetchArtifact(
      requestId: string,
      stage: string,
      filename: string,
    ): Promise<unknown | null> {
      const url = `${base}/artifacts/${encodeURIComponent(requestId)}/${encodeURIComponent(stage)}/${encodeURIComponent(filename)}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${env.token}` },
      });
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new Error(`agent-fs returned ${res.status} for ${url}`);
      }
      return (await res.json()) as unknown;
    },
  };
}

// ---------------------------------------------------------------------------
// Phase 3.5 Step 2 -- upload side (worker exit-hook artifact uploader).
//
// Mirrors the read-side `ArtifactsClient` but for the worker exit hook that
// pushes completed artifact files from the agent's home directory back into
// agent-fs after a successful video-stage run.
//
// Routing convention (matches the Step 1 agent-fs routes):
//   .json files  -> JSON PUT  /artifacts/<req>/<stage>/<filename>
//   everything else -> binary PUT /artifacts/<req>/<stage>/<filename>/binary
// ---------------------------------------------------------------------------

/**
 * Upload-side counterpart to `ArtifactsClient`. Called by the worker
 * exit hook to push artifact files from the agent's home directory into
 * agent-fs after a successful video-stage run.
 *
 * Throws on transport errors or non-2xx responses; callers are expected
 * to catch per-file and continue (warn-log-continue pattern).
 */
export interface ArtifactUploadClient {
  /**
   * Upload one artifact file to agent-fs. The implementation routes
   * `.json` filenames via the JSON PUT route and everything else via
   * the binary PUT route. Throws on transport or HTTP non-2xx failures;
   * the caller wraps each call in its own try/catch (warn-log-continue).
   */
  uploadArtifact(
    requestId: string,
    stage: string,
    filename: string,
    body: Buffer,
  ): Promise<void>;
}

export interface HttpArtifactUploadClientEnv {
  /** Base URL for agent-fs, e.g. `http://agent-fs:7100`. No trailing slash. */
  url: string;
  /** Bearer token for the dispatcher's agent-fs credentials. */
  token: string;
}

/**
 * Production implementation. Routes `.json` filenames to the JSON PUT
 * route and all other filenames to the binary PUT route added in
 * Step 1 (`/artifacts/:req/:stage/:filename/binary`).
 *
 * Non-2xx responses throw with HTTP status + URL in the message. Network
 * errors propagate naturally. Both are caught by the caller's per-file
 * try/catch.
 */
export function httpArtifactUploadClient(
  env: HttpArtifactUploadClientEnv,
): ArtifactUploadClient {
  const base = env.url.replace(/\/+$/, "");
  return {
    async uploadArtifact(
      requestId: string,
      stage: string,
      filename: string,
      body: Buffer,
    ): Promise<void> {
      const isJson = filename.endsWith(".json");
      const encodedPath = `${encodeURIComponent(requestId)}/${encodeURIComponent(stage)}/${encodeURIComponent(filename)}`;
      const url = isJson
        ? `${base}/artifacts/${encodedPath}`
        : `${base}/artifacts/${encodedPath}/binary`;

      // 30-second per-request timeout. Without this, an unresponsive
      // agent-fs will hang the worker exit hook indefinitely, blocking
      // run finalization. The timeout covers both the JSON and binary
      // routes; 30s is generous for a LAN/container hop but bounded.
      const signal = AbortSignal.timeout(30_000);

      let res: Response;
      if (isJson) {
        // Parse and re-serialise so the agent-fs JSON route receives a
        // well-formed JSON body via its `c.req.json()` call.
        const parsed: unknown = JSON.parse(body.toString("utf-8"));
        res = await fetch(url, {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${env.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(parsed),
          signal,
        });
      } else {
        // Convert Buffer to Uint8Array so the fetch BodyInit type is
        // satisfied (Buffer extends Uint8Array but TypeScript's fetch
        // overloads do not widen to Buffer directly).
        res = await fetch(url, {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${env.token}`,
            "Content-Type": "application/octet-stream",
          },
          body: new Uint8Array(body),
          signal,
        });
      }

      if (!res.ok) {
        throw new Error(`agent-fs returned ${res.status} for PUT ${url}`);
      }
    },
  };
}
