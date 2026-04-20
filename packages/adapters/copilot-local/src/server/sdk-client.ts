import type { ChildProcess } from "node:child_process";
import type {
  CopilotClientOptions,
  CopilotSession,
  GetAuthStatusResponse,
  GetStatusResponse,
  MessageOptions,
  ModelInfo,
  ResumeSessionConfig,
  SessionConfig,
  SessionEvent,
} from "@github/copilot-sdk";

export type CopilotSessionLike = Pick<
  CopilotSession,
  "sessionId" | "send" | "getMessages" | "disconnect" | "abort" | "on" | "rpc"
>;

export interface CopilotClientLike {
  start(): Promise<void>;
  stop(): Promise<unknown>;
  forceStop(): Promise<void>;
  ping(message?: string): Promise<{ message: string; timestamp: number; protocolVersion?: number }>;
  getStatus(): Promise<GetStatusResponse>;
  getAuthStatus(): Promise<GetAuthStatusResponse>;
  listModels(): Promise<ModelInfo[]>;
  createSession(config: SessionConfig): Promise<CopilotSessionLike>;
  resumeSession(sessionId: string, config: ResumeSessionConfig): Promise<CopilotSessionLike>;
  cliProcess?: ChildProcess | null;
}

type CopilotClientFactory = (options: CopilotClientOptions) => CopilotClientLike | Promise<CopilotClientLike>;

let copilotSdkModulePromise: Promise<typeof import("@github/copilot-sdk")> | null = null;

async function loadCopilotSdk(): Promise<typeof import("@github/copilot-sdk")> {
  copilotSdkModulePromise ??= import("@github/copilot-sdk");
  return copilotSdkModulePromise;
}

const defaultCopilotClientFactory: CopilotClientFactory = async (options) => {
  const { CopilotClient } = await loadCopilotSdk();
  return new CopilotClient(options) as unknown as CopilotClientLike;
};

let copilotClientFactory: CopilotClientFactory = defaultCopilotClientFactory;

export async function createCopilotClient(options: CopilotClientOptions): Promise<CopilotClientLike> {
  return await copilotClientFactory(options);
}

export function setCopilotClientFactoryForTests(factory: CopilotClientFactory | null): void {
  copilotClientFactory = factory ?? defaultCopilotClientFactory;
}

export const approveAll: NonNullable<SessionConfig["onPermissionRequest"]> = async (...args) => {
  const { approveAll: sdkApproveAll } = await loadCopilotSdk();
  return await sdkApproveAll(...args);
};
export type {
  CopilotClientOptions,
  GetAuthStatusResponse,
  MessageOptions,
  ModelInfo,
  ResumeSessionConfig,
  SessionConfig,
  SessionEvent,
};
