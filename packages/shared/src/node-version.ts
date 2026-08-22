export const MINIMUM_NODE_VERSION = "24.11.0";
export const NODE_VERSION_INSTALL_GUIDE_URL =
  "https://github.com/paperclipai/paperclip/blob/master/doc/INSTALLING.md#recommended-install";
const NODE_VERSION_WARNING_EMITTED = Symbol.for("@paperclipai/node-version-warning-emitted");

function parseVersion(version: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isSupportedNodeVersion(version: string): boolean {
  const current = parseVersion(version);
  const minimum = parseVersion(MINIMUM_NODE_VERSION);
  if (!current || !minimum) return false;

  for (let index = 0; index < current.length; index += 1) {
    if (current[index] > minimum[index]) return true;
    if (current[index] < minimum[index]) return false;
  }
  return true;
}

export function formatNodeVersionWarning(version: string): string | null {
  if (isSupportedNodeVersion(version)) return null;
  const currentVersion = version.trim() || "unknown";
  return [
    `[paperclip] warning: Node.js ${currentVersion} is unsupported. Paperclip requires Node.js ${MINIMUM_NODE_VERSION} or newer.`,
    "Upgrade Node.js with your version manager, or follow the recommended downloaded install.sh workflow:",
    `  ${NODE_VERSION_INSTALL_GUIDE_URL}`,
    "The piped install.sh form cannot upgrade an unsupported Node.js runtime.",
    "Restart Paperclip after upgrading.",
  ].join("\n");
}

export function warnIfUnsupportedNodeVersion(
  version: string,
  warn: (message: string) => void,
): boolean {
  const warning = formatNodeVersionWarning(version);
  if (!warning) return false;

  const warningState = globalThis as unknown as Record<symbol, boolean | undefined>;
  if (warningState[NODE_VERSION_WARNING_EMITTED]) return false;

  warningState[NODE_VERSION_WARNING_EMITTED] = true;
  warn(warning);
  return true;
}
