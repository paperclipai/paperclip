import net from "node:net";

export function checkPort(port: number): Promise<{ available: boolean; error?: string }> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        resolve({ available: false, error: `Port ${port} is already in use` });
      } else {
        resolve({ available: false, error: err.message });
      }
    });
    server.once("listening", () => {
      server.close(() => resolve({ available: true }));
    });
    server.listen(port, "127.0.0.1");
  });
}

function formatHostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function resolveHealthProbeHosts(host: string): string[] {
  const normalized = host.trim().toLowerCase();
  const hosts = new Set<string>();

  if (!normalized || normalized === "0.0.0.0" || normalized === "::") {
    hosts.add("127.0.0.1");
    hosts.add("localhost");
    return Array.from(hosts);
  }

  hosts.add(normalized);
  hosts.add("127.0.0.1");
  if (normalized !== "localhost") {
    hosts.add("localhost");
  }
  return Array.from(hosts);
}

export async function probePaperclipHealth(
  host: string,
  port: number,
): Promise<{ healthy: boolean; url?: string }> {
  const timeoutMs = 1500;

  for (const probeHost of resolveHealthProbeHosts(host)) {
    const url = `http://${formatHostForUrl(probeHost)}:${port}/api/health`;
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) {
        return { healthy: true, url };
      }
    } catch {
      // Ignore probe errors and try the next candidate.
    }
  }

  return { healthy: false };
}
