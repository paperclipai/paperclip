// Manual smoke for sprint-1/wire-create-app — exercises the exact legal-layer
// boot path that startServer() runs. Two modes:
//   $ tsx scripts/smoke-legal-boot.ts                            # no env  → no boot
//   $ ODYSSEUS_PROFILE=small-firm tsx scripts/smoke-legal-boot.ts  # boots small-firm
//
// Asserts the visible behavior: when ODYSSEUS_PROFILE is set, the runtime
// boots, profile name + gate count are logged, and an evaluate() call returns
// an array. When unset, nothing happens. Bad profile keys log + return undefined
// (do not crash). Intended for ad-hoc verification only; not run in CI.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bootLegalRuntime,
  defaultLegalLayerPaths,
  type LegalRuntime,
} from "../src/services/legal/index.js";

const scriptDir = dirname(fileURLToPath(import.meta.url));
// scripts/ → server/ → repo root
const repoRoot = resolve(scriptDir, "..", "..");

const profileKey = process.env.ODYSSEUS_PROFILE;
console.log(`[smoke] ODYSSEUS_PROFILE=${profileKey ?? "(unset)"}`);
console.log(`[smoke] repoRoot=${repoRoot}`);

let legalLayer: LegalRuntime | undefined;
if (profileKey) {
  const paths = defaultLegalLayerPaths(repoRoot);
  try {
    legalLayer = await bootLegalRuntime({ ...paths, profileKey });
    console.log(
      JSON.stringify({
        msg: "[legal-layer] booted",
        profile: legalLayer.profile.profile,
        gateCount: Object.keys(legalLayer.gates).length,
        riskGatesDir: paths.riskGatesDir,
        profilesDir: paths.profilesDir,
      }),
    );
    const firings = legalLayer.evaluate({
      action: "adapter.invoke",
      agentId: "smoke-agent",
    });
    console.log(
      JSON.stringify({
        msg: "[legal-layer] pre-action gate evaluation",
        agentId: "smoke-agent",
        action: "adapter.invoke",
        firingsCount: firings.length,
        firings,
      }),
    );
  } catch (err) {
    console.error(
      JSON.stringify({
        msg: "[legal-layer] boot failed; continuing without legal layer",
        err: err instanceof Error ? err.message : String(err),
      }),
    );
  }
} else {
  console.log("[smoke] no profile configured — skipping legal-layer boot (legacy paperclip behavior).");
}

console.log(`[smoke] done. legalLayer present=${legalLayer !== undefined}`);
