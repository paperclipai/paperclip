const DEV_RUNNER_CONTROL_PORT_OFFSET = 20_001;
const MAX_PORT = 65_535;
const MIN_EPHEMERAL_PORT = 1_024;

function assertValidPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) {
    throw new Error(`Invalid port: ${port}`);
  }
}

function getOriginPort(origin: URL): number {
  if (origin.port) {
    const port = Number.parseInt(origin.port, 10);
    assertValidPort(port);
    return port;
  }
  if (origin.protocol === "https:") return 443;
  if (origin.protocol === "http:") return 80;
  throw new Error(`Unsupported protocol: ${origin.protocol}`);
}

export function resolveDevRunnerControlPort(serverPort: number): number {
  assertValidPort(serverPort);
  if (serverPort <= MAX_PORT - DEV_RUNNER_CONTROL_PORT_OFFSET) {
    return serverPort + DEV_RUNNER_CONTROL_PORT_OFFSET;
  }
  return Math.max(MIN_EPHEMERAL_PORT, serverPort - DEV_RUNNER_CONTROL_PORT_OFFSET);
}

export function resolveDevRunnerRestartUrl(appOrigin: string): string | null {
  try {
    const origin = new URL(appOrigin);
    const serverPort = getOriginPort(origin);
    origin.port = String(resolveDevRunnerControlPort(serverPort));
    origin.pathname = "/restart";
    origin.search = "";
    origin.hash = "";
    return origin.toString();
  } catch {
    return null;
  }
}
