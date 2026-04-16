import detectPort from "detect-port";

export async function detectAvailablePort(port: number, hostname?: string): Promise<number> {
  const normalizedHostname = hostname?.trim();

  if (!normalizedHostname) {
    return detectPort(port);
  }

  return detectPort({ port, hostname: normalizedHostname });
}
