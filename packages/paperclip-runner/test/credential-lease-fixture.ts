import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { createServer, type Server } from "node:net";

export function credentialLeasePorts(home: string): readonly number[] {
  const userScope =
    typeof process.getuid === "function" ? String(process.getuid()) : "win32";
  return credentialLeasePortsForScope(userScope, home);
}

export function credentialLeasePortsForScope(
  userScope: string,
  home: string,
): readonly number[] {
  const digest = createHash("sha256")
    .update("paperclip-managed-codex-lease-v2:")
    .update(userScope)
    .update("\0")
    .update(home)
    .digest();
  const start = digest.readUInt16BE(0) % 16_384;
  const step = (digest.readUInt16BE(2) | 1) % 16_384;
  return Array.from(
    { length: 3 },
    (_, index) => 49_152 + ((start + index * step) % 16_384),
  );
}

export async function credentialHomeWithAvailableLeasePorts(
  nextHome: () => Promise<string>,
): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const home = await realpath(await nextHome());
    const reservations: Server[] = [];
    try {
      for (const port of credentialLeasePorts(home)) {
        const server = createServer((socket) => socket.destroy());
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen({ host: "127.0.0.1", port, exclusive: true }, resolve);
        });
        reservations.push(server);
      }
      return home;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || attempt === 7) {
        throw error;
      }
    } finally {
      const results = await Promise.allSettled(
        reservations.map(
          (server) => new Promise<void>((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
          }),
        ),
      );
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    }
  }
  throw new Error("Credential fixture port preparation exhausted");
}
