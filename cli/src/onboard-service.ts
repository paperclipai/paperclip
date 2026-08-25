import path from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { installCommand } from "./commands/install.js";
import { resolvePaperclipInstanceId } from "./config/home.js";
import {
  readInstallManifest,
  resolveInstallStorePaths,
  type InstallManifest,
} from "./install-store.js";
import {
  detectServiceManager,
  isExecutableFile,
  resolveServiceShimPath,
  type ServiceManagerDetection,
} from "./services/service-manager.js";
import { packageVersion } from "./version.js";

export type OnboardServiceOptions = {
  yes?: boolean;
  installService?: boolean;
};

type EnsureShimResult = { ok: boolean; installedNow: boolean; reason?: string };

// Source checkouts carry the repository placeholder version; installing
// that as an npm spec would fetch an ancient release (or nothing) instead
// of the running code. Only real calendar versions are installable.
export function isInstallableReleaseVersion(version: string): boolean {
  return /^\d{4}\.\d{1,4}\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version);
}

type OnboardServiceDependencies = {
  detect: (instanceId: string) => Promise<ServiceManagerDetection>;
  ensureServiceShim: () => Promise<EnsureShimResult>;
  confirm: () => Promise<boolean>;
  confirmLinger: () => Promise<boolean>;
  isInteractive: () => boolean;
  info: (message: string) => void;
  success: (message: string) => void;
  warn: (message: string) => void;
};

const defaultDependencies: OnboardServiceDependencies = {
  detect: (instanceId) => detectServiceManager({ instanceId }),
  // The service definition targets the managed shim. An ephemeral run (npx)
  // never lays it down, so installing the service without this step creates
  // a definition that crash-loops on a missing binary.
  ensureServiceShim: async () => {
    const shimPath = resolveServiceShimPath();
    if (await isExecutableFile(shimPath)) {
      return { ok: true, installedNow: false };
    }
    const storeShimPath = resolveInstallStorePaths().shimPath;
    if (path.resolve(shimPath) !== path.resolve(storeShimPath)) {
      return {
        ok: false,
        installedNow: false,
        reason: `no executable exists at ${shimPath} (PAPERCLIP_SHIM_PATH), and it is outside the managed install store`,
      };
    }
    let manifest: InstallManifest | null = null;
    try {
      manifest = readInstallManifest();
    } catch {}
    try {
      if (manifest?.source === "git" && manifest.repo) {
        // A managed git payload must be preserved as-is: reinstall the
        // exact revision the manifest records, not an npm release.
        await installCommand({ repo: manifest.repo, ref: manifest.sha ?? manifest.ref, yes: true });
      } else if (isInstallableReleaseVersion(packageVersion)) {
        // packageVersion, not cliVersion: a managed executable's cliVersion
        // carries provenance text that is not an installable npm spec.
        await installCommand({ version: packageVersion, yes: true });
      } else {
        return {
          ok: false,
          installedNow: false,
          reason:
            `this build reports version ${packageVersion}, which is not an installable release; ` +
            "run `paperclipai install` (or `paperclipai install --repo <repo> --ref <ref>` for source builds) first",
        };
      }
    } catch (error) {
      return {
        ok: false,
        installedNow: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    if (await isExecutableFile(shimPath)) {
      return { ok: true, installedNow: true };
    }
    return {
      ok: false,
      installedNow: false,
      reason: `the managed install completed but no executable shim appeared at ${shimPath}`,
    };
  },
  confirm: async () => {
    const answer = await p.confirm({
      message: "Install Paperclip as a background service?",
      initialValue: true,
    });
    return !p.isCancel(answer) && answer === true;
  },
  confirmLinger: async () => {
    const answer = await p.confirm({
      message: "Allow Paperclip to keep running after logout? This may request system authorization.",
      initialValue: false,
    });
    return !p.isCancel(answer) && answer === true;
  },
  isInteractive: () => process.stdin.isTTY === true && process.stdout.isTTY === true,
  info: (message) => p.log.message(pc.dim(message)),
  success: (message) => p.log.success(message),
  warn: (message) => p.log.warn(message),
};

export async function handleOnboardService(
  options: OnboardServiceOptions,
  dependencies: Partial<OnboardServiceDependencies> = {},
): Promise<boolean> {
  const deps = { ...defaultDependencies, ...dependencies };
  if (options.installService === false) return false;

  const explicitlyRequested = options.installService === true;
  const canPrompt = options.yes !== true && deps.isInteractive();
  if (!explicitlyRequested && !canPrompt) {
    deps.info(
      "Background service not installed. Use `paperclipai onboard --install-service` or `paperclipai service install` to opt in.",
    );
    return false;
  }

  const instanceId = resolvePaperclipInstanceId();
  const detection = await deps.detect(instanceId);
  if (!detection.supported) {
    if (explicitlyRequested) deps.warn(detection.reason);
    return false;
  }

  if (!explicitlyRequested && !(await deps.confirm())) return false;

  // A definition pointing at a missing binary crash-loops in the platform
  // supervisor's penalty box while doctor blames a port conflict.
  // Materialize the managed install first, or decline with the repair path
  // instead of installing a corpse.
  const shim = await deps.ensureServiceShim();
  if (!shim.ok) {
    deps.warn(
      `Background service not installed: ${shim.reason ?? "the managed install could not be completed"}. ` +
        "Run `paperclipai install`, then `paperclipai service install`.",
    );
    return false;
  }
  if (shim.installedNow) {
    deps.success("Installed the managed paperclipai payload and command shim for the service.");
  }

  await detection.manager.install({ startNow: true, startOnLogin: true });
  if (!explicitlyRequested && detection.manager.enableLinger && await deps.confirmLinger()) {
    await detection.manager.enableLinger();
  }
  deps.success(`Installed and started ${detection.manager.serviceName}.`);
  return true;
}

// Onboarding falls back to offering a foreground start when nothing else
// will serve. A just-installed service is already serving, so offering the
// start would only run the user into the already-running instance guard.
export function shouldOfferForegroundStart(options: {
  serviceInstalled: boolean;
  startAlreadyDecided: boolean;
  invokedByRun: boolean;
  interactive: boolean;
}): boolean {
  return (
    !options.startAlreadyDecided &&
    !options.serviceInstalled &&
    !options.invokedByRun &&
    options.interactive
  );
}
