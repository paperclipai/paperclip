// K15 (redeploy.ts): give the server process an emulated host name, so its process-space hash
// differs from the previous deploy's, as a replaced container's does. Loaded with `--import`
// before the server. Node children forked with the server's execArgv inherit it, as they share its container.
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";

const hostname = process.env.RESTART_CHAOS_REDEPLOY_HOSTNAME?.trim();
if (hostname) {
  os.hostname = () => hostname;
  // `import { hostname } from "node:os"` reads the ESM export, which only follows the CJS object after a sync.
  syncBuiltinESMExports();
}
