import detectPort from "detect-port";

/**
 * Pick the HTTP listen port. When strict mode is on, fail if the configured
 * port is not free (detect-port would otherwise choose the next available).
 */
export async function resolveListenPort(configuredPort: number, strictListenPort: boolean): Promise<number> {
  const selected = await detectPort(configuredPort);
  if (strictListenPort && selected !== configuredPort) {
    throw new Error(
      `PAPERCLIP_STRICT_LISTEN_PORT is enabled but port ${configuredPort} is not available ` +
        `(next free port would be ${selected}). Free the port or unset PAPERCLIP_STRICT_LISTEN_PORT.`,
    );
  }
  return selected;
}
