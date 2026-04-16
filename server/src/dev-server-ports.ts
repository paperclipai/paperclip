import detectPort from "detect-port";

export interface DevRunnerPortSelection {
  requestedPort: number;
  selectedPort: number;
  hmrPort: number;
  attempts: number;
}

const defaultHost = "0.0.0.0";
const maxAttempts = 100;
const maxPort = 65_535;

export function resolveViteHmrPort(serverPort: number): number {
  if (serverPort <= 55_535) {
    return serverPort + 10_000;
  }
  return Math.max(1_024, serverPort - 10_000);
}

export async function selectAvailableDevRunnerPort(
  requestedPort: number,
  options?: { host?: string },
): Promise<DevRunnerPortSelection> {
  let candidate = requestedPort;
  const hostname = options?.host?.trim() || defaultHost;

  for (let attempts = 1; attempts <= maxAttempts; attempts += 1) {
    if (candidate < 1 || candidate > maxPort) {
      throw new Error(`No available dev server port found starting from ${requestedPort}`);
    }

    const detectedServerPort = await detectPort({ port: candidate, hostname });
    if (detectedServerPort !== candidate) {
      candidate = detectedServerPort;
      continue;
    }

    const hmrPort = resolveViteHmrPort(candidate);
    const detectedHmrPort = await detectPort({ port: hmrPort, hostname });
    if (detectedHmrPort !== hmrPort) {
      candidate += 1;
      continue;
    }

    return {
      requestedPort,
      selectedPort: candidate,
      hmrPort,
      attempts,
    };
  }

  throw new Error(`No available dev server port pair found starting from ${requestedPort}`);
}
