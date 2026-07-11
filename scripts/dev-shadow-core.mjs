import { connect } from "node:net";

const DEFAULT_SOURCE_API = "http://127.0.0.1:3100";
const DEFAULT_SHADOW_PORT = 3101;
const DATABASE_PROBE_TIMEOUT_MS = 3000;

function requiredValue(args, index, flag) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function normalizeSourceApi(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid --source-api URL: ${value}`);
  }
  if (parsed.protocol !== "http:") throw new Error("--source-api must use http:// for the local dev resolver");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) {
    throw new Error("--source-api must target localhost or a loopback address");
  }
  parsed.pathname = parsed.pathname.replace(/\/$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function normalizeDatabaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("--database-url must be a PostgreSQL connection URL, not an embedded data directory");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("--database-url must use postgres:// or postgresql://; embedded data-directory sharing is unsafe");
  }
  if (!parsed.hostname) throw new Error("--database-url must include a database host");
  return parsed.toString();
}

export function parseDevShadowArgs(args) {
  const options = { sourceApi: DEFAULT_SOURCE_API, port: DEFAULT_SHADOW_PORT };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--source-api") {
      options.sourceApi = requiredValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--port") {
      const value = requiredValue(args, index, arg);
      const port = Number.parseInt(value, 10);
      if (!Number.isInteger(port) || port < 1 || port > 65535 || String(port) !== value) {
        throw new Error(`Invalid --port value: ${value}`);
      }
      options.port = port;
      index += 1;
      continue;
    }
    if (arg === "--database-url") {
      options.databaseUrl = requiredValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--embedded-postgres-data-dir") {
      throw new Error("Shadow dev must connect through DATABASE_URL; sharing an embedded Postgres data directory is unsafe");
    }
    throw new Error(`Unknown dev:shadow option: ${arg}`);
  }
  return {
    sourceApi: normalizeSourceApi(options.sourceApi),
    port: options.port,
    databaseUrl: options.databaseUrl ? normalizeDatabaseUrl(options.databaseUrl) : undefined,
  };
}

export async function resolveDevShadowDatabaseUrl(options, fetchImpl = fetch) {
  if (options.databaseUrl) return normalizeDatabaseUrl(options.databaseUrl);
  const resolverUrl = `${normalizeSourceApi(options.sourceApi)}/api/health/dev-database-source`;
  let response;
  try {
    response = await fetchImpl(resolverUrl, { signal: AbortSignal.timeout(DATABASE_PROBE_TIMEOUT_MS) });
  } catch (error) {
    throw new Error(`Could not reach source Paperclip API at ${options.sourceApi}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    throw new Error(`Source Paperclip API at ${options.sourceApi} did not expose a local dev database (${response.status}). Start it with pnpm dev or pass --database-url.`);
  }
  const payload = await response.json();
  if (typeof payload.databaseUrl !== "string" || !payload.databaseUrl.trim()) {
    throw new Error(`Source Paperclip API at ${options.sourceApi} returned no database URL`);
  }
  return normalizeDatabaseUrl(payload.databaseUrl);
}

export async function probeDevShadowDatabase(databaseUrl, timeoutMs = DATABASE_PROBE_TIMEOUT_MS) {
  const parsed = new URL(normalizeDatabaseUrl(databaseUrl));
  const port = Number.parseInt(parsed.port || "5432", 10);
  await new Promise((resolve, reject) => {
    const socket = connect({ host: parsed.hostname, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out connecting to PostgreSQL at ${parsed.hostname}:${port}`));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`Could not connect to PostgreSQL at ${parsed.hostname}:${port}: ${error.message}`));
    });
  });
}

export function createDevShadowEnv(options, databaseUrl, baseEnv = process.env) {
  const sourceApi = normalizeSourceApi(options.sourceApi);
  return {
    ...baseEnv,
    PORT: String(options.port),
    DATABASE_URL: normalizeDatabaseUrl(databaseUrl),
    PAPERCLIP_API_URL: `http://127.0.0.1:${options.port}`,
    PAPERCLIP_UI_DEV_MIDDLEWARE: "true",
    PAPERCLIP_SHADOW_DEV_SOURCE_API: sourceApi,
    HEARTBEAT_SCHEDULER_ENABLED: "false",
    PAPERCLIP_DB_BACKUP_ENABLED: "false",
    PAPERCLIP_MIGRATION_PROMPT: "never",
    PAPERCLIP_MIGRATION_AUTO_APPLY: "false",
  };
}
