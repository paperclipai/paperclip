import { join } from "node:path";
import { verifyNativeAcpxInstallation } from "./installation-integrity.js";

/** Setup verifies the same execution bytes as admission without spawning Hermes. */
export async function verifyHermesRuntimeFiles(distributionRoot: string, expectedClosureSha256: string): Promise<void> {
  const installation = await verifyNativeAcpxInstallation({
    distributionRoot, expectedClosureSha256, manifestPath: join(distributionRoot, "manifest.json"),
    executable: "python/bin/python3.12", pythonEntrypoint: "entry.py", fixedArguments: [],
  });
  const lease = await installation.openCommand();
  await lease.close();
}
