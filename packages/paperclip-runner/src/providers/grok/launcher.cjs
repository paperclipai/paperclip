// This launcher is admitted by digest and receives a verified native executable.
// Never resolve an executable through PATH or accept command-line overrides.
const { isAbsolute, join } = require("node:path");
const { constants, openSync, fstatSync, readSync, closeSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const executable = process.env.PAPERCLIP_GROK_VERIFIED_EXECUTABLE;
if (!executable || !isAbsolute(executable)) {
  throw new Error("Verified Grok executable is unavailable");
}
const environment = { ...process.env };
delete environment.PAPERCLIP_GROK_VERIFIED_EXECUTABLE;

// Grok 1.0.13 can cache the pre-refresh model list during ACP initialization.
// Refresh an expiring subscription first, without inference or protocol output.
// The verified launcher remains the fenced owner throughout this subprocess.
if (!environment.XAI_API_KEY && environment.GROK_HOME && isAbsolute(environment.GROK_HOME)) {
  let auth;
  try {
    const fd = openSync(join(environment.GROK_HOME, "auth.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || stat.size > 256 * 1024) {
        throw new Error("Grok subscription credential is invalid");
      }
      const bytes = Buffer.alloc(256 * 1024 + 1);
      try {
        let size = 0;
        while (size < bytes.length) {
          const count = readSync(fd, bytes, size, bytes.length - size, size);
          if (count === 0) break;
          size += count;
        }
        if (size > 256 * 1024) throw new Error("Grok subscription credential exceeds its bound");
        auth = JSON.parse(bytes.subarray(0, size).toString("utf8"));
      } finally { bytes.fill(0); }
    } finally { closeSync(fd); }
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error("Grok subscription credential is invalid");
  }
  const entries = auth && typeof auth === "object" && !Array.isArray(auth) ? Object.values(auth) : [];
  const rawExpiry = entries.length === 1 ? entries[0]?.expires_at : undefined;
  // Match the managed Grok auth contract: ISO-8601, epoch seconds, or milliseconds.
  const isoExpiry = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
  const expiry = typeof rawExpiry === "number" && Number.isFinite(rawExpiry)
    ? rawExpiry < 1e12 ? rawExpiry * 1000 : rawExpiry
    : typeof rawExpiry === "string" && isoExpiry.test(rawExpiry) ? Date.parse(rawExpiry) : NaN;
  if (Number.isFinite(expiry) && expiry <= Date.now() + 60_000) {
    // Descriptor-backed executables must retain their exact descriptor in the
    // child. Other descriptors, including ACP stdin/stdout, are not forwarded.
    const stdio = ["ignore", "ignore", "ignore"];
    const descriptor = /^\/(?:proc\/self\/fd|dev\/fd)\/(\d+)$/.exec(executable);
    if (descriptor) {
      const fd = Number(descriptor[1]);
      if (!Number.isSafeInteger(fd) || fd < 3 || fd > 1024) throw new Error("Verified Grok descriptor is invalid");
      while (stdio.length <= fd) stdio.push("ignore");
      stdio[fd] = fd;
    }
    const refreshed = spawnSync(executable, ["models"], {
      env: environment, stdio, timeout: 15_000, killSignal: "SIGKILL",
    });
    if (refreshed.error || refreshed.status !== 0 || refreshed.signal) {
      throw new Error("Grok subscription refresh failed; reconnect Grok Build");
    }
  }
}
process.execve(executable, [executable, "agent", "--no-leader", "stdio"], environment);
