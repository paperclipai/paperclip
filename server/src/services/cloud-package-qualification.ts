import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { z } from "zod";
import { createBundledPluginPackageResolver, type BundledPluginRegistration } from "./bundled-plugin-package.js";
import type { ResolvedBundledPlugin } from "./bundled-plugins.js";
import { distributionBundleDigest } from "./distribution-plugin-catalog.js";
import { cloudConfigurationDigest } from "./cloud-configuration-evidence.js";
import { cloudBundledPackageDigest } from "./cloud-bundled-package-digest.js";

export const qualificationBlockerSchema = z.object({
  code: z.string(), pluginKey: z.string().optional(), reason: z.string(),
  registeredVersion: z.string().optional(), imageVersion: z.string().optional(),
}).strict();
export type QualificationBlocker = z.infer<typeof qualificationBlockerSchema>;
export const cloudPackageEvidenceSchema = z.object({
  catalogKey: z.string(), pluginKey: z.string(), packageDigest: z.string().nullable(),
  imageManifestDigest: z.string().nullable(), approvedManifestDigest: z.string().nullable(),
}).strict();
export type CloudPackageEvidence = z.infer<typeof cloudPackageEvidenceSchema>;

export async function inspectCloudPackages(input: {
  installs: readonly ResolvedBundledPlugin[];
  registrations: readonly BundledPluginRegistration[];
  catalogRoot?: string;
  loadManifest: (packageRoot: string) => Promise<PaperclipPluginManifestV1 | null>;
}) {
  const started = performance.now();
  const resolver = createBundledPluginPackageResolver(input.installs);
  const registrations = new Map(input.registrations.map((record) => [record.pluginKey, record]));
  const selected = new Set(input.installs.map((install) => install.pluginKey));
  const blockers: QualificationBlocker[] = input.registrations.filter((record) => !selected.has(record.pluginKey)).map((record) => ({
    code: "unsupported_plugin_registration", pluginKey: record.pluginKey, reason: "An installed plugin is not selected from the current image", registeredVersion: record.version,
  }));
  const packages: CloudPackageEvidence[] = [];
  for (const install of [...input.installs].sort((left, right) => left.pluginKey < right.pluginKey ? -1 : left.pluginKey > right.pluginKey ? 1 : 0)) {
    const registration = registrations.get(install.pluginKey);
    const evidence: CloudPackageEvidence = {
      catalogKey: install.key, pluginKey: install.pluginKey, packageDigest: null,
      imageManifestDigest: null, approvedManifestDigest: registration ? cloudConfigurationDigest(registration.manifestJson) : null,
    };
    packages.push(evidence);
    let stage = "missing_bundled_package";
    try {
      resolver.assertActivation({ packageRoot: install.localPath });
      stage = "unverified_package_integrity";
      evidence.packageDigest = install.distribution ? distributionBundleDigest(install.localPath) : cloudBundledPackageDigest(install.localPath, { catalogRoot: input.catalogRoot });
      if (install.distribution && evidence.packageDigest !== install.distribution.digest) {
        blockers.push({ code: "package_integrity_mismatch", pluginKey: install.pluginKey, reason: "Current package bytes do not match the verified distribution digest" });
        continue;
      }
      stage = "missing_manifest_evidence";
      const manifest = await input.loadManifest(install.localPath);
      if (!manifest) {
        blockers.push({ code: stage, pluginKey: install.pluginKey, reason: "The current image has no verified plugin manifest" });
        continue;
      }
      evidence.imageManifestDigest = cloudConfigurationDigest(manifest);
      if (!registration) {
        blockers.push({ code: "missing_plugin_registration", pluginKey: install.pluginKey, reason: "The current image package is not registered in the database", imageVersion: manifest.version });
        continue;
      }
      const inspected = resolver.inspect(registration, manifest);
      if (!inspected.compatible) blockers.push({
        code: inspected.code, pluginKey: install.pluginKey, reason: inspected.reason,
        registeredVersion: registration.version, imageVersion: manifest.version,
      });
    } catch {
      blockers.push({ code: stage, pluginKey: install.pluginKey, reason: "The current image package could not be verified" });
    }
  }
  const packageEvidenceDigest = cloudConfigurationDigest(packages.map(({ approvedManifestDigest: _approved, ...evidence }) => evidence));
  return { packages, blockers, packageEvidenceDigest, packageInspectionDurationMs: Math.round(performance.now() - started) };
}
