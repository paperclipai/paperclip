import type {
  AdapterConfigSchema,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterModel,
  AdapterSessionCodec,
  AdapterSkillContext,
  AdapterSkillSnapshot,
  HireApprovedHookResult,
  HireApprovedPayload,
  ServerAdapterModule,
  TranscriptEntry,
} from "@paperclipai/adapter-utils";

export function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult>;
export function testEnvironment(ctx?: Partial<AdapterEnvironmentTestContext>): Promise<AdapterEnvironmentTestResult>;
export function detectModel(configPath?: string): Promise<{
  model: string;
  provider: string;
  source: string;
  candidates?: string[];
} | null>;
export function detectModelSync(configPath?: string): {
  model: string;
  provider: string;
  source: string;
  candidates?: string[];
} | null;
export function listHermesModels(options?: { forceRefresh?: boolean; configPath?: string }): Promise<AdapterModel[]>;
export function getStaticHermesModels(): AdapterModel[];
export function listSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot>;
export function syncSkills(
  ctx: AdapterSkillContext,
  desiredSkills: string[],
): Promise<AdapterSkillSnapshot>;
export function getConfigSchema(): Promise<AdapterConfigSchema>;
export function onHireApproved(
  payload: HireApprovedPayload,
  adapterConfig?: Record<string, unknown>,
): Promise<HireApprovedHookResult>;
export function parseHermesStdoutLine(line: string, ts: string): TranscriptEntry[];
export function createHermesStdoutParser(): {
  parseLine: (line: string, ts: string) => TranscriptEntry[];
  reset: () => void;
};
export const sessionCodec: AdapterSessionCodec;
export function createServerAdapter(): ServerAdapterModule;
