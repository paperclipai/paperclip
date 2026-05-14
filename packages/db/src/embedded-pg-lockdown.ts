import net from "node:net";

export async function assertPgNotReachableOnInterfaces(
  addresses: string[],
  port: number,
): Promise<void> {
  for (const address of addresses) {
    await probeOne(address, port);
  }
}

function probeOne(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(port, host);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(
        new Error(
          `Embedded PostgreSQL binding lockdown assertion failed: probe to ${host}:${port} timed out. ` +
          "Ambiguous result is treated as a security failure. " +
          "Ensure PostgreSQL is not bound to non-loopback interfaces.",
        ),
      );
    }, 500);

    socket.on("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      reject(
        new Error(
          `Embedded PostgreSQL binding lockdown assertion failed: PostgreSQL is reachable on ${host}:${port}. ` +
          "This means the listen_addresses lockdown did not take effect. " +
          "Refusing to start to prevent data exposure.",
        ),
      );
    });

    socket.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      socket.destroy();
      if (err.code === "ECONNREFUSED") {
        resolve();
      } else {
        reject(
          new Error(
            `Embedded PostgreSQL binding lockdown assertion failed: probe to ${host}:${port} encountered ` +
            `${err.code ?? err.message}. Ambiguous result is treated as a security failure. ` +
            "Refusing to start to prevent data exposure.",
          ),
        );
      }
    });
  });
}
