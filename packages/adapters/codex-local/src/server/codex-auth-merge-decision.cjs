const fs = require("fs");

// Co-change notice: parseAuth below mirrors hasUsableAuthPayload in
// packages/adapters/codex-local/src/server/codex-home.ts. If the auth format
// changes (new shape, renamed field), update both sites together.
function parseAuth(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return { kind: "unusable" };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "unusable" };
  }

  if (typeof parsed.OPENAI_API_KEY === "string" && parsed.OPENAI_API_KEY.trim().length > 0) {
    return { kind: "apikey" };
  }

  const tokens = parsed.tokens;
  if (tokens === null || typeof tokens !== "object" || Array.isArray(tokens)) {
    return { kind: "unusable" };
  }

  const accountId = typeof tokens.account_id === "string" ? tokens.account_id.trim() : "";
  const hasTokenMaterial = ["id_token", "access_token", "refresh_token"].some((key) => {
    const value = tokens[key];
    return typeof value === "string" && value.trim().length > 0;
  });
  if (!accountId || !hasTokenMaterial) {
    return { kind: "unusable" };
  }

  const lastRefresh = typeof parsed.last_refresh === "string" ? Date.parse(parsed.last_refresh) : NaN;
  return {
    kind: "subscription",
    accountId,
    lastRefresh: Number.isFinite(lastRefresh) ? lastRefresh : null,
  };
}

const [sandboxAuthPath, hostAuthPath] = process.argv.slice(2);
const sandboxAuth = parseAuth(sandboxAuthPath);
const hostAuth = parseAuth(hostAuthPath);

if (
  hostAuth.kind === "unusable" ||
  sandboxAuth.kind === "unusable" ||
  sandboxAuth.kind !== hostAuth.kind
) {
  process.exit(20);
}

if (hostAuth.kind === "apikey") {
  process.exit(20);
}

if (sandboxAuth.accountId !== hostAuth.accountId) {
  process.exit(20);
}

if (
  hostAuth.lastRefresh !== null &&
  sandboxAuth.lastRefresh !== null &&
  hostAuth.lastRefresh > sandboxAuth.lastRefresh
) {
  process.exit(20);
}

process.exit(10);
