import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Db } from "@paperclipai/db";
import { claudeAccountUsage } from "@paperclipai/db";
import {
  inferClaudeAccountTier,
  type ClaudeAccountTier,
  type ClaudeAccountUsageSnapshot,
  type ClaudeAccountsUsageResponse,
  type ClaudeUsageWindow,
} from "@paperclipai/shared";
import { desc } from "drizzle-orm";

const execFileAsync = promisify(execFile);

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const OAUTH_BETA = "oauth-2025-04-20";
// Claude Code's public OAuth client id (used for the rotating refresh grant).
const CLAUDE_CODE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

// Rate-limit discipline: both endpoints 429 aggressively. Probe each account at
// most once per minute; back off exponentially after a 429; only refresh a token
// when the stored one is actually rejected (401) or within the expiry skew.
const MIN_PROBE_INTERVAL_MS = 60_000;
const TOKEN_EXPIRY_SKEW_MS = 5 * 60_000;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 30 * 60_000;
const FETCH_TIMEOUT_MS = 12_000;

function claudeConfigDir(): string {
  const fromEnv = process.env.CLAUDE_CONFIG_DIR;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) return fromEnv.trim();
  return path.join(os.homedir(), ".claude");
}

function profileDir(): string {
  return process.env.CLAUDE_AUTH_PROFILE_DIR?.trim() || path.join(claudeConfigDir(), "auth-profiles");
}

function liveCredentialsPath(): string {
  return process.env.CLAUDE_CREDENTIALS_FILE?.trim() || path.join(claudeConfigDir(), ".credentials.json");
}

function tierOverrides(): Record<string, ClaudeAccountTier> | undefined {
  const raw = process.env.CLAUDE_ACCOUNT_TIERS;
  if (!raw || raw.trim().length === 0) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, ClaudeAccountTier> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (v === "ours" || v === "wameling" || v === "unknown") out[k] = v;
    }
    return out;
  } catch {
    return undefined;
  }
}

/** Convert a utilization value to a 0-100 integer percent.
 *  Mirrors packages/adapters/claude-local/src/server/quota.ts:toPercent — the API
 *  returns 0-100 percentages now but older clients saw 0-1 fractions. */
export function toPercent(utilization: number | null | undefined): number | null {
  if (utilization == null) return null;
  return Math.min(100, Math.round(utilization < 1 ? utilization * 100 : utilization));
}

interface AnthropicUsageWindow {
  utilization?: number | null;
  resets_at?: string | null;
}
interface AnthropicUsageResponse {
  five_hour?: AnthropicUsageWindow | null;
  seven_day?: AnthropicUsageWindow | null;
  seven_day_opus?: AnthropicUsageWindow | null;
  seven_day_sonnet?: AnthropicUsageWindow | null;
}

function mapWindow(w: AnthropicUsageWindow | null | undefined): ClaudeUsageWindow | null {
  if (w == null) return null;
  return { pct: toPercent(w.utilization), resetsAt: w.resets_at ?? null };
}

export interface ProfileCredentials {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    subscriptionType?: string;
    [k: string]: unknown;
  };
  oauthAccount?: { emailAddress?: string; [k: string]: unknown };
  [k: string]: unknown;
}

async function readJsonFile(p: string): Promise<ProfileCredentials | null> {
  try {
    const raw = await fs.readFile(p, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as ProfileCredentials) : null;
  } catch {
    return null;
  }
}

async function readActiveProfile(): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(profileDir(), "active"), "utf8");
    const name = raw.trim();
    return name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

class RateLimitError extends Error {}

async function fetchUsage(token: string): Promise<AnthropicUsageResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "anthropic-beta": OAUTH_BETA,
      },
      signal: controller.signal,
    });
    if (resp.status === 429) throw new RateLimitError("usage endpoint rate limited (429)");
    if (resp.status === 401 || resp.status === 403) {
      const err = new Error(`unauthorized (${resp.status})`);
      (err as Error & { unauthorized?: boolean }).unauthorized = true;
      throw err;
    }
    if (!resp.ok) throw new Error(`anthropic usage api returned ${resp.status}`);
    return (await resp.json()) as AnthropicUsageResponse;
  } finally {
    clearTimeout(timer);
  }
}

export interface RefreshResult {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

/** POST the rotating refresh grant. Returns the NEW token pair. Both tokens must
 *  then be persisted atomically — the old refresh token is consumed. */
async function refreshToken(refresh: string): Promise<RefreshResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refresh,
        client_id: CLAUDE_CODE_CLIENT_ID,
      }),
      signal: controller.signal,
    });
    if (resp.status === 429) throw new RateLimitError("token endpoint rate limited (429)");
    if (!resp.ok) throw new Error(`token endpoint returned ${resp.status}`);
    const body = (await resp.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!body.access_token || !body.refresh_token) {
      throw new Error("token endpoint response missing access_token/refresh_token");
    }
    const expiresInMs = (typeof body.expires_in === "number" ? body.expires_in : 3600) * 1000;
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: Date.now() + expiresInMs,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Persist a rotated token pair back into the profile credentials file ATOMICALLY,
 * under the same `auth-profiles/.lock` flock that `claude-auth-switch` uses, with a
 * timestamped backup. Preserves every other field of the profile. Bricking a
 * profile (losing the rotated refresh token) is the principal risk here, so this
 * mirrors claude-auth-switch's save logic exactly: backup -> write tmp -> rename,
 * all under an exclusive flock so a concurrent `claude-auth-switch use/sync` can't
 * interleave.
 */
export async function persistRotatedTokens(
  profile: string,
  current: ProfileCredentials,
  next: RefreshResult,
): Promise<void> {
  const dir = profileDir();
  const profilePath = path.join(dir, `${profile}.credentials.json`);
  const lockPath = path.join(dir, ".lock");
  const backupDir = path.join(claudeConfigDir(), "backups");
  await fs.mkdir(backupDir, { recursive: true });

  const oauth = { ...(current.claudeAiOauth ?? {}) };
  oauth.accessToken = next.accessToken;
  oauth.refreshToken = next.refreshToken;
  oauth.expiresAt = next.expiresAt;
  const updated: ProfileCredentials = { ...current, claudeAiOauth: oauth };

  // Basic-ISO timestamp, e.g. 20260630T212512Z (matches claude-auth-switch's backups).
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const backupPath = path.join(backupDir, `profile-before-refresh.${profile}.${stamp}.credentials.json`);
  const tmpPath = path.join(dir, `.${profile}.refresh.${process.pid}.tmp`);

  await fs.writeFile(tmpPath, JSON.stringify(updated, null, 2), { mode: 0o600 });

  // Atomic, flock-guarded swap. $1=profile $2=tmp $3=backup. cp -p backs up the
  // existing file (best effort); mv -f atomically renames the new file into place.
  try {
    await execFileAsync(
      "flock",
      [
        "-x",
        lockPath,
        "sh",
        "-c",
        '[ -f "$1" ] && cp -p -- "$1" "$3"; chmod 600 -- "$2"; mv -f -- "$2" "$1"',
        "sh",
        profilePath,
        tmpPath,
        backupPath,
      ],
      { timeout: 10_000 },
    );
  } catch (error) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
}

interface CacheEntry {
  lastProbeAt: number;
  accessToken: string | null;
  accessTokenExpiresAt: number | null;
  backoffUntil: number;
  snapshot: ClaudeAccountUsageSnapshot | null;
}

function emptyWindowsSnapshot(
  profile: string,
  email: string | null,
  subscriptionType: string | null,
  tier: ClaudeAccountTier,
  active: boolean,
  source: ClaudeAccountUsageSnapshot["source"],
  error: string | null,
): ClaudeAccountUsageSnapshot {
  return {
    profile,
    email,
    subscriptionType,
    tier,
    active,
    fiveHour: null,
    sevenDay: null,
    sevenDayOpus: null,
    sevenDaySonnet: null,
    probedAt: new Date().toISOString(),
    source,
    error,
  };
}

export function claudeAccountUsageService(db: Db) {
  const cache = new Map<string, CacheEntry>();

  async function listProfiles(): Promise<string[]> {
    try {
      const entries = await fs.readdir(profileDir());
      return entries
        .filter((e) => e.endsWith(".credentials.json"))
        .map((e) => e.slice(0, -".credentials.json".length))
        .sort();
    } catch {
      return [];
    }
  }

  function backoffMs(attempts: number): number {
    return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));
  }

  async function probeOne(
    profile: string,
    activeProfile: string | null,
    liveToken: string | null,
  ): Promise<ClaudeAccountUsageSnapshot> {
    const now = Date.now();
    const active = profile === activeProfile;
    const creds = await readJsonFile(path.join(profileDir(), `${profile}.credentials.json`));
    const email = creds?.oauthAccount?.emailAddress ?? null;
    const subscriptionType = creds?.claudeAiOauth?.subscriptionType ?? null;
    const tier = inferClaudeAccountTier(profile, tierOverrides());
    const cached = cache.get(profile);

    // Rate-limit / backoff: honor <=1 probe per minute per account and any active
    // 429 backoff window by returning the last good snapshot instead of a call.
    if (cached) {
      const within = now - cached.lastProbeAt < MIN_PROBE_INTERVAL_MS;
      const backedOff = now < cached.backoffUntil;
      if ((within || backedOff) && cached.snapshot) {
        return cached.snapshot;
      }
    }

    let snapshot: ClaudeAccountUsageSnapshot;
    try {
      let token: string | null;
      let source: ClaudeAccountUsageSnapshot["source"];
      if (active) {
        token = liveToken ?? creds?.claudeAiOauth?.accessToken ?? null;
        source = "live";
      } else if (
        cached?.accessToken &&
        cached.accessTokenExpiresAt &&
        cached.accessTokenExpiresAt - now > TOKEN_EXPIRY_SKEW_MS
      ) {
        token = cached.accessToken;
        source = "refreshed";
      } else {
        token = creds?.claudeAiOauth?.accessToken ?? null;
        source = "snapshot";
      }
      if (!token) throw new Error("no access token in profile");

      let usage: AnthropicUsageResponse;
      try {
        usage = await fetchUsage(token);
      } catch (error) {
        const unauthorized = (error as { unauthorized?: boolean }).unauthorized === true;
        if (unauthorized && !active && creds?.claudeAiOauth?.refreshToken) {
          // Stale snapshot token: rotate + persist, then retry once.
          const next = await refreshToken(creds.claudeAiOauth.refreshToken);
          await persistRotatedTokens(profile, creds, next);
          cache.set(profile, {
            lastProbeAt: now,
            accessToken: next.accessToken,
            accessTokenExpiresAt: next.expiresAt,
            backoffUntil: cached?.backoffUntil ?? 0,
            snapshot: cached?.snapshot ?? null,
          });
          token = next.accessToken;
          source = "refreshed";
          usage = await fetchUsage(token);
        } else {
          throw error;
        }
      }

      snapshot = {
        profile,
        email,
        subscriptionType,
        tier,
        active,
        fiveHour: mapWindow(usage.five_hour),
        sevenDay: mapWindow(usage.seven_day),
        sevenDayOpus: mapWindow(usage.seven_day_opus),
        sevenDaySonnet: mapWindow(usage.seven_day_sonnet),
        probedAt: new Date().toISOString(),
        source,
        error: null,
      };
      cache.set(profile, {
        lastProbeAt: now,
        accessToken: source === "refreshed" ? cache.get(profile)?.accessToken ?? token : null,
        accessTokenExpiresAt: cache.get(profile)?.accessTokenExpiresAt ?? null,
        backoffUntil: 0,
        snapshot,
      });
    } catch (error) {
      const rateLimited = error instanceof RateLimitError;
      const prev = cache.get(profile);
      const attempts = rateLimited ? (prev && prev.backoffUntil > now ? 2 : 1) : 0;
      snapshot = emptyWindowsSnapshot(
        profile,
        email,
        subscriptionType,
        tier,
        active,
        "error",
        error instanceof Error ? error.message : String(error),
      );
      cache.set(profile, {
        lastProbeAt: now,
        accessToken: prev?.accessToken ?? null,
        accessTokenExpiresAt: prev?.accessTokenExpiresAt ?? null,
        backoffUntil: rateLimited ? now + backoffMs(attempts) : prev?.backoffUntil ?? 0,
        snapshot: prev?.snapshot ?? snapshot,
      });
      // On rate-limit with a prior good snapshot, prefer surfacing the prior data.
      if (rateLimited && prev?.snapshot) return prev.snapshot;
    }
    return snapshot;
  }

  async function persistSnapshot(s: ClaudeAccountUsageSnapshot): Promise<void> {
    const probedAt = new Date(s.probedAt);
    const row = {
      profile: s.profile,
      email: s.email,
      subscriptionType: s.subscriptionType,
      tier: s.tier,
      active: s.active,
      fiveHourPct: s.fiveHour?.pct ?? null,
      fiveHourResetsAt: s.fiveHour?.resetsAt ? new Date(s.fiveHour.resetsAt) : null,
      sevenDayPct: s.sevenDay?.pct ?? null,
      sevenDayResetsAt: s.sevenDay?.resetsAt ? new Date(s.sevenDay.resetsAt) : null,
      sevenDayOpusPct: s.sevenDayOpus?.pct ?? null,
      sevenDayOpusResetsAt: s.sevenDayOpus?.resetsAt ? new Date(s.sevenDayOpus.resetsAt) : null,
      sevenDaySonnetPct: s.sevenDaySonnet?.pct ?? null,
      sevenDaySonnetResetsAt: s.sevenDaySonnet?.resetsAt ? new Date(s.sevenDaySonnet.resetsAt) : null,
      source: s.source,
      error: s.error,
      probedAt,
      updatedAt: new Date(),
    };
    await db
      .insert(claudeAccountUsage)
      .values(row)
      .onConflictDoUpdate({ target: claudeAccountUsage.profile, set: row });
  }

  function rowToSnapshot(r: typeof claudeAccountUsage.$inferSelect): ClaudeAccountUsageSnapshot {
    const win = (pct: number | null, resetsAt: Date | null): ClaudeUsageWindow | null =>
      pct == null && resetsAt == null ? null : { pct, resetsAt: resetsAt ? resetsAt.toISOString() : null };
    return {
      profile: r.profile,
      email: r.email,
      subscriptionType: r.subscriptionType,
      tier: (r.tier as ClaudeAccountTier) ?? "unknown",
      active: r.active,
      fiveHour: win(r.fiveHourPct, r.fiveHourResetsAt),
      sevenDay: win(r.sevenDayPct, r.sevenDayResetsAt),
      sevenDayOpus: win(r.sevenDayOpusPct, r.sevenDayOpusResetsAt),
      sevenDaySonnet: win(r.sevenDaySonnetPct, r.sevenDaySonnetResetsAt),
      probedAt: r.probedAt.toISOString(),
      source: r.source as ClaudeAccountUsageSnapshot["source"],
      error: r.error,
    };
  }

  return {
    /** Read persisted snapshots without probing the network. */
    async getPersisted(): Promise<ClaudeAccountsUsageResponse> {
      const rows = await db
        .select()
        .from(claudeAccountUsage)
        .orderBy(desc(claudeAccountUsage.active), claudeAccountUsage.profile);
      const accounts = rows.map(rowToSnapshot);
      const capturedAt =
        accounts.length > 0
          ? accounts.reduce<string | null>(
              (max, a) => (max == null || a.probedAt > max ? a.probedAt : max),
              null,
            )
          : null;
      return { capturedAt, accounts };
    },

    /** Probe every profile (honoring cadence/backoff), persist, and return all. */
    async refreshAll(): Promise<ClaudeAccountsUsageResponse> {
      const [profiles, activeProfile] = await Promise.all([listProfiles(), readActiveProfile()]);
      const liveCreds = await readJsonFile(liveCredentialsPath());
      const liveToken = liveCreds?.claudeAiOauth?.accessToken ?? null;

      const accounts: ClaudeAccountUsageSnapshot[] = [];
      // Sequential to avoid bursting both endpoints; each account is independently
      // rate-limited but we never want N simultaneous refreshes.
      for (const profile of profiles) {
        const snapshot = await probeOne(profile, activeProfile, liveToken);
        accounts.push(snapshot);
        await persistSnapshot(snapshot);
      }
      accounts.sort((a, b) => Number(b.active) - Number(a.active) || a.profile.localeCompare(b.profile));
      const capturedAt =
        accounts.length > 0
          ? accounts.reduce<string | null>((max, a) => (max == null || a.probedAt > max ? a.probedAt : max), null)
          : null;
      return { capturedAt, accounts };
    },
  };
}

export type ClaudeAccountUsageService = ReturnType<typeof claudeAccountUsageService>;
