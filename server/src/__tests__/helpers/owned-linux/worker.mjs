// PRIVATE unrun normal SDK worker. Normal host launcher already invokes its
// canonical parseRemoteRunnerProcessIdentity on the ORIGINAL command stdout
// before processIdentityReady/onSpawn and the real PRP connection. Preserve that
// owner rather than importing a giant App module into the provider worker.
import { readFile } from "node:fs/promises";
import { startLinuxQualificationWorker } from "./qualification-provider.js";
import { createOwnedLinuxProvider } from "./owned-provider-implementation.mjs";
const config = JSON.parse(await readFile(new URL("./owned-runtime-config.json", import.meta.url), "utf8"));
startLinuxQualificationWorker(createOwnedLinuxProvider(config), import.meta.url);
