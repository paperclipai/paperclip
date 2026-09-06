import { createServer } from "node:net";
import { derivePaperclipViteHmrPort } from "../../packages/shared/src/runtime-exposure/ports.js";

export const RUNNER_E2E_EMBEDDED_POSTGRES_PORT = 54_329;

export interface LoopbackPortReservation {
  port: number;
  close(): Promise<void>;
}

export type OpenLoopbackPort = (
  requestedPort: number,
) => Promise<LoopbackPortReservation>;

async function openLoopbackPort(
  requestedPort: number,
): Promise<LoopbackPortReservation> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Failed to reserve a loopback port");
  }
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

export function runnerE2EServerPortConflictsWithDatabase(
  serverPort: number,
  databasePort = RUNNER_E2E_EMBEDDED_POSTGRES_PORT,
) {
  return (
    serverPort === databasePort ||
    derivePaperclipViteHmrPort(serverPort) === databasePort
  );
}

function isAddressInUse(error: unknown) {
  return (error as NodeJS.ErrnoException | undefined)?.code === "EADDRINUSE";
}

export async function reserveRunnerE2EServerPort(
  options: {
    databasePort?: number;
    maxAttempts?: number;
    openPort?: OpenLoopbackPort;
  } = {},
) {
  const databasePort =
    options.databasePort ?? RUNNER_E2E_EMBEDDED_POSTGRES_PORT;
  const maxAttempts = options.maxAttempts ?? 32;
  const openPort = options.openPort ?? openLoopbackPort;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const serverReservation = await openPort(0);
    let hmrReservation: LoopbackPortReservation | undefined;
    try {
      if (
        runnerE2EServerPortConflictsWithDatabase(
          serverReservation.port,
          databasePort,
        )
      ) {
        continue;
      }
      const hmrPort = derivePaperclipViteHmrPort(serverReservation.port);
      try {
        hmrReservation = await openPort(hmrPort);
      } catch (error) {
        if (isAddressInUse(error)) continue;
        throw error;
      }
      return serverReservation.port;
    } finally {
      await hmrReservation?.close();
      await serverReservation.close();
    }
  }

  throw new Error(
    `Failed to reserve a conflict-free Paperclip/Vite port pair after ${maxAttempts} attempts`,
  );
}
