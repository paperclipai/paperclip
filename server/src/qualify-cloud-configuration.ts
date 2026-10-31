import path from "node:path";
import { pathToFileURL } from "node:url";
import { createDb } from "@paperclipai/db";
import { cloudConfigurationMigrationService } from "./services/cloud-configuration-migration.js";
import { qualifyCloudConfigurationForCurrentImage } from "./services/cloud-configuration-qualification.js";

export async function runCloudConfigurationQualification(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const allowed = new Set(["--migrate", "--expected-package-evidence", "--recheck-external-revision"]);
  let migrate = false;
  let expectedPackageEvidenceDigest: string | undefined;
  let recheckRevision: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!allowed.has(argument)) throw new Error(`Unknown qualification argument: ${argument}`);
    if (argument === "--migrate") migrate = true;
    if (argument === "--expected-package-evidence") {
      expectedPackageEvidenceDigest = args[++index];
      if (!expectedPackageEvidenceDigest || !/^sha256:[a-f0-9]{64}$/.test(expectedPackageEvidenceDigest)) throw new Error("A SHA-256 package evidence digest is required");
    }
    if (argument === "--recheck-external-revision") {
      const value = args[++index];
      if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("A nonnegative receipt revision is required");
      recheckRevision = Number(value);
    }
  }
  const url = env.DATABASE_URL?.trim();
  if (!url) throw new Error("DATABASE_URL is required for Cloud configuration qualification");
  const db = createDb(url);
  try {
    const service = cloudConfigurationMigrationService(db, { runtimeEnv: env });
    if (migrate) await service.migrate();
    if (recheckRevision !== undefined) await service.recheckLegacyExternalRegistrations(recheckRevision);
    const report = await qualifyCloudConfigurationForCurrentImage(db, { runtimeEnv: env, expectedPackageEvidenceDigest });
    if (!report) throw new Error("Cloud configuration qualification requires a managed instance");
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.configurationPackagesEligible && (!expectedPackageEvidenceDigest || report.samePackageOverlapEligible) ? 0 : 2;
  } finally {
    await db.$client.end({ timeout: 5 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCloudConfigurationQualification(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Cloud configuration qualification failed"}\n`);
    process.exitCode = 1;
  });
}
