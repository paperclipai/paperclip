import { request as httpRequest, type IncomingMessage } from "node:http";

// ---------------------------------------------------------------------------
// Docker Engine API helpers (Unix socket, no CLI dependency)
// ---------------------------------------------------------------------------

const DOCKER_SOCKET = process.env.DOCKER_SOCKET_PATH ?? "/var/run/docker.sock";
const DOCKER_API_VERSION = "v1.45";

interface DockerContainer {
  Id: string;
  Names: string[];
  State: string;
  Status: string;
  Labels: Record<string, string>;
}

function dockerApi(
  method: string,
  path: string,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        socketPath: DOCKER_SOCKET,
        path: `/${DOCKER_API_VERSION}${path}`,
        method,
      },
      (res: IncomingMessage) => {
        let raw = "";
        res.on("data", (chunk: Buffer) => {
          raw += chunk.toString();
        });
        res.on("end", () => {
          let data: unknown = raw;
          try {
            data = JSON.parse(raw);
          } catch {
            /* keep raw string */
          }
          resolve({ status: res.statusCode ?? 0, data });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function findDeerFlowContainers(): Promise<DockerContainer[]> {
  const filter = encodeURIComponent(
    JSON.stringify({ name: ["deerflow"] }),
  );
  const { data } = await dockerApi(
    "GET",
    `/containers/json?all=true&filters=${filter}`,
  );
  if (!Array.isArray(data)) return [];
  return data as DockerContainer[];
}

async function startContainer(id: string): Promise<void> {
  const { status } = await dockerApi("POST", `/containers/${id}/start`);
  // 204 = started, 304 = already running
  if (status !== 204 && status !== 304) {
    throw new Error(`Failed to start container ${id}: HTTP ${status}`);
  }
}

async function stopContainer(id: string): Promise<void> {
  const { status } = await dockerApi("POST", `/containers/${id}/stop?t=10`);
  // 204 = stopped, 304 = already stopped
  if (status !== 204 && status !== 304) {
    throw new Error(`Failed to stop container ${id}: HTTP ${status}`);
  }
}

// ---------------------------------------------------------------------------
// Health check polling
// ---------------------------------------------------------------------------

const HEALTH_POLL_INTERVAL_MS = 2_000;
const HEALTH_POLL_TIMEOUT_MS = 60_000;

async function isHealthy(langgraphUrl: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3_000);
    const res = await fetch(`${langgraphUrl}/ok`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForHealthy(langgraphUrl: string): Promise<void> {
  const deadline = Date.now() + HEALTH_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isHealthy(langgraphUrl)) return;
    await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
  }
  throw new Error(
    `DeerFlow did not become healthy within ${HEALTH_POLL_TIMEOUT_MS / 1000}s`,
  );
}

// ---------------------------------------------------------------------------
// Reference-counted container lifecycle
// ---------------------------------------------------------------------------

const IDLE_SHUTDOWN_MS = 10 * 60 * 1_000; // 10 minutes

let activeRuns = 0;
let shutdownTimer: ReturnType<typeof setTimeout> | null = null;
let startingPromise: Promise<void> | null = null;

function cancelShutdownTimer(): void {
  if (shutdownTimer) {
    clearTimeout(shutdownTimer);
    shutdownTimer = null;
  }
}

async function ensureContainersRunning(
  langgraphUrl: string,
): Promise<void> {
  // Fast path: already healthy
  if (await isHealthy(langgraphUrl)) return;

  // Deduplicate concurrent startup attempts
  if (startingPromise) {
    await startingPromise;
    return;
  }

  startingPromise = (async () => {
    try {
      const containers = await findDeerFlowContainers();
      if (containers.length === 0) {
        throw new Error(
          "No DeerFlow containers found. Ensure they are defined in docker-compose and have been created at least once.",
        );
      }

      await Promise.all(
        containers
          .filter((c) => c.State !== "running")
          .map((c) => startContainer(c.Id)),
      );

      await waitForHealthy(langgraphUrl);
    } finally {
      startingPromise = null;
    }
  })();

  await startingPromise;
}

async function stopContainersIfIdle(): Promise<void> {
  if (activeRuns > 0) return;
  try {
    const containers = await findDeerFlowContainers();
    await Promise.all(
      containers
        .filter((c) => c.State === "running")
        .map((c) => stopContainer(c.Id)),
    );
  } catch (err) {
    // Non-fatal — log but don't throw
    console.warn("[deerflow-lifecycle] Failed to stop containers:", err);
  }
}

/**
 * Increment ref count and ensure DeerFlow containers are running and healthy.
 * Call before making any DeerFlow API requests.
 */
export async function acquire(langgraphUrl: string): Promise<void> {
  cancelShutdownTimer();
  activeRuns++;
  try {
    await ensureContainersRunning(langgraphUrl);
  } catch (err) {
    activeRuns--;
    throw err;
  }
}

/**
 * Decrement ref count. When it reaches zero, schedule idle shutdown.
 * Call in a finally block after DeerFlow API work is done.
 */
export function release(): void {
  activeRuns = Math.max(0, activeRuns - 1);
  if (activeRuns === 0) {
    cancelShutdownTimer();
    shutdownTimer = setTimeout(() => {
      void stopContainersIfIdle();
    }, IDLE_SHUTDOWN_MS);
    // Don't prevent Node from exiting if this is the only timer
    if (
      shutdownTimer &&
      typeof shutdownTimer === "object" &&
      "unref" in shutdownTimer
    ) {
      shutdownTimer.unref();
    }
  }
}
