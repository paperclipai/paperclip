import * as p from "@clack/prompts";
import pc from "picocolors";
import { resolvePaperclipInstanceId } from "./config/home.js";
import {
  detectServiceManager,
  type ServiceManagerDetection,
} from "./services/service-manager.js";

export type OnboardServiceOptions = {
  yes?: boolean;
  installService?: boolean;
};

type OnboardServiceDependencies = {
  detect: (instanceId: string) => Promise<ServiceManagerDetection>;
  confirm: () => Promise<boolean>;
  confirmLinger: () => Promise<boolean>;
  isInteractive: () => boolean;
  info: (message: string) => void;
  success: (message: string) => void;
  warn: (message: string) => void;
};

const defaultDependencies: OnboardServiceDependencies = {
  detect: (instanceId) => detectServiceManager({ instanceId }),
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

  await detection.manager.install({ startNow: true, startOnLogin: true });
  if (!explicitlyRequested && detection.manager.enableLinger && await deps.confirmLinger()) {
    await detection.manager.enableLinger();
  }
  deps.success(`Installed and started ${detection.manager.serviceName}.`);
  return true;
}
