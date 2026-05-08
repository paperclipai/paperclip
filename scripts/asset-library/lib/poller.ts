// Background poller — auto-comments on `[review-and-ship]` issues when a new
// IssueDocument is uploaded.
//
// GLA-989: poll every 30s, dedupe by docKey per issue, post one comment per
// new doc with a deep-link into the asset library. State file lives at
// `scripts/asset-library/.doc-state.json` (relative to repo root).
//
// Started by `instrumentation.ts` on Next.js server startup; can also be
// driven directly via `node scripts/asset-library/lib/poller-cli.mjs` for
// debugging.

import fs from "fs";
import path from "path";

const TITLE_PREFIX = "[review-and-ship]";

export type PollerConfig = {
  apiUrl: string;
  apiKey: string;
  companyId: string;
  assetLibraryUrl: string;
  stateFile: string;
  intervalMs: number;
  fetchImpl?: typeof fetch;
  logger?: { info: (msg: string, data?: unknown) => void; warn: (msg: string, data?: unknown) => void; error: (msg: string, data?: unknown) => void };
};

type IssueDocSummary = { id: string; key: string; updatedAt: string };
type IssueSummary = { id: string; identifier: string; title: string };

type DocState = {
  documentId: string;
  firstSeenAt: string;
  commentedAt: string | null;
};

type StateFile = {
  bootstrappedAt: string | null;
  issues: Record<string, Record<string, DocState>>;
};

const EMPTY_STATE: StateFile = { bootstrappedAt: null, issues: {} };

export function loadState(stateFile: string): StateFile {
  try {
    const raw = fs.readFileSync(stateFile, "utf8");
    const parsed = JSON.parse(raw) as Partial<StateFile>;
    return {
      bootstrappedAt: typeof parsed.bootstrappedAt === "string" ? parsed.bootstrappedAt : null,
      issues:
        parsed.issues && typeof parsed.issues === "object" && !Array.isArray(parsed.issues)
          ? (parsed.issues as StateFile["issues"])
          : {},
    };
  } catch {
    return { ...EMPTY_STATE, issues: {} };
  }
}

export function saveState(stateFile: string, state: StateFile): void {
  const dir = path.dirname(stateFile);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${stateFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmp, stateFile);
}

function buildCommentBody(issueId: string, docKey: string, assetLibraryUrl: string): string {
  const base = assetLibraryUrl.replace(/\/$/, "");
  const url = `${base}/asset/${issueId}/${encodeURIComponent(docKey)}`;
  return `🖼 New asset available for review: [→ open in Asset Library](${url})`;
}

async function listReviewAndShipIssues(cfg: PollerConfig): Promise<IssueSummary[]> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const url = `${cfg.apiUrl.replace(/\/$/, "")}/api/companies/${cfg.companyId}/issues?titlePrefix=${encodeURIComponent(TITLE_PREFIX)}`;
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`list issues ${res.status}: ${await res.text().catch(() => "")}`);
  }
  const payload = (await res.json()) as Array<Partial<IssueSummary>>;
  return payload
    .filter(
      (i): i is IssueSummary =>
        typeof i?.id === "string"
        && typeof i?.title === "string"
        && i.title.startsWith(TITLE_PREFIX),
    )
    .map((i) => ({ id: i.id, identifier: i.identifier ?? i.id.slice(0, 8), title: i.title }));
}

async function listIssueDocs(cfg: PollerConfig, issueId: string): Promise<IssueDocSummary[]> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const url = `${cfg.apiUrl.replace(/\/$/, "")}/api/issues/${issueId}/documents`;
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`list docs ${issueId} ${res.status}`);
  }
  const payload = (await res.json()) as Array<Partial<IssueDocSummary>>;
  return payload
    .filter(
      (d): d is IssueDocSummary =>
        typeof d?.id === "string" && typeof d?.key === "string" && typeof d?.updatedAt === "string",
    )
    .map((d) => ({ id: d.id, key: d.key, updatedAt: d.updatedAt }));
}

async function postComment(cfg: PollerConfig, issueId: string, body: string): Promise<void> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const url = `${cfg.apiUrl.replace(/\/$/, "")}/api/issues/${issueId}/comments`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) {
    throw new Error(`post comment ${issueId} ${res.status}: ${await res.text().catch(() => "")}`);
  }
}

export type PollResult = {
  scannedIssues: number;
  newDocs: number;
  commentsPosted: number;
  bootstrap: boolean;
  errors: Array<{ issueId: string; key?: string; message: string }>;
};

export async function pollOnce(cfg: PollerConfig): Promise<PollResult> {
  const log = cfg.logger ?? console;
  const state = loadState(cfg.stateFile);
  const bootstrap = state.bootstrappedAt === null;
  const result: PollResult = {
    scannedIssues: 0,
    newDocs: 0,
    commentsPosted: 0,
    bootstrap,
    errors: [],
  };

  let issues: IssueSummary[];
  try {
    issues = await listReviewAndShipIssues(cfg);
  } catch (err) {
    result.errors.push({ issueId: "*", message: (err as Error).message });
    return result;
  }
  result.scannedIssues = issues.length;

  for (const issue of issues) {
    let docs: IssueDocSummary[];
    try {
      docs = await listIssueDocs(cfg, issue.id);
    } catch (err) {
      result.errors.push({ issueId: issue.id, message: (err as Error).message });
      continue;
    }
    const known = state.issues[issue.id] ?? {};
    state.issues[issue.id] = known;
    for (const doc of docs) {
      if (known[doc.key]) continue;
      result.newDocs += 1;
      const now = new Date().toISOString();
      if (bootstrap) {
        // Silent baseline — record without commenting so we don't flood on
        // first start over an already-populated company.
        known[doc.key] = { documentId: doc.id, firstSeenAt: now, commentedAt: null };
        continue;
      }
      const body = buildCommentBody(issue.id, doc.key, cfg.assetLibraryUrl);
      try {
        await postComment(cfg, issue.id, body);
        known[doc.key] = { documentId: doc.id, firstSeenAt: now, commentedAt: now };
        result.commentsPosted += 1;
        log.info(`[asset-library/poller] commented on ${issue.identifier} doc.key=${doc.key}`);
      } catch (err) {
        result.errors.push({ issueId: issue.id, key: doc.key, message: (err as Error).message });
        // Do NOT record on failure — retry next tick.
      }
    }
  }

  if (bootstrap) {
    state.bootstrappedAt = new Date().toISOString();
    log.info(`[asset-library/poller] bootstrap complete — baseline recorded for ${result.scannedIssues} issues, ${result.newDocs} pre-existing docs`);
  }

  try {
    saveState(cfg.stateFile, state);
  } catch (err) {
    result.errors.push({ issueId: "*", message: `saveState: ${(err as Error).message}` });
  }
  return result;
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export function startPoller(cfg: PollerConfig): () => void {
  const log = cfg.logger ?? console;
  if (timer) {
    log.warn("[asset-library/poller] already started; ignoring second startPoller call");
    return () => {};
  }
  const tick = async () => {
    if (running) return; // overlap guard if a poll runs longer than the interval
    running = true;
    try {
      const r = await pollOnce(cfg);
      if (r.errors.length > 0) {
        log.warn(`[asset-library/poller] poll completed with ${r.errors.length} error(s)`, r.errors.slice(0, 5));
      }
    } catch (err) {
      log.error(`[asset-library/poller] poll crashed: ${(err as Error).message}`);
    } finally {
      running = false;
    }
  };
  log.info(`[asset-library/poller] started (interval=${cfg.intervalMs}ms, state=${cfg.stateFile})`);
  // Fire the first tick immediately so bootstrap completes on startup.
  void tick();
  timer = setInterval(() => void tick(), cfg.intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
}
