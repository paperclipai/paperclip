import fs from "node:fs/promises";
import path from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { installCommand } from "./commands/install.js";
import { resolvePaperclipInstanceId } from "./config/home.js";
import { resolveInstallStorePaths } from "./install-store.js";
import {
  detectServiceManager,
  resolveServiceShimPath,
  type ServiceManagerDetection,
} from "./services/service-manager.js";
import { cliVersion } from "./version.js";

export type OnboardServiceOptions = {
  yes?: boolean;
  installService?: boolean;
};

type EnsureShimResult = { ok: boolean; installedNow: boolean; reason?: string };

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
    try {
      await fs.access(shimPath);
      return { ok: true, installedNow: false };
    } catch {}
    const storeShimPath = resolveInstallStorePaths().shimPath;
    if (path.resolve(shimPath) !== path.resolve(storeShimPath)) {
      return {
        ok: false,
        installedNow: false,
        reason: `nothing is executable at ${shimPath} (PAPERCLIP_SHIM_PATH), and it is outside the managed install store`,
      };
    }
    try {
      await installCommand({ version: cliVersion, yes: true });
    } catch (error) {
      return {
        ok: false,
        installedNow: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    try {
      await fs.access(shimPath);
      return { ok: true, installedNow: true };
    } catch {
      return {
        ok: false,
        installedNow: false,
        reason: `the managed install completed but no shim appeared at ${shimPath}`,
      };
    }
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
