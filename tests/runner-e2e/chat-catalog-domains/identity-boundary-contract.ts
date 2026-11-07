import type { Page } from "@playwright/test";
import type { RunnerApi } from "../api.js";
import type { ChatCatalogCase, ChatCatalogGrade } from "../chat-catalog-contract.js";
import type { ChatScenario } from "../chat-feature-cases.js";
import type { CredentialName, MatrixExecution } from "../types.js";

export const identityBoundaryScenarioIds = ["access.sign-in", "onboarding.new-instance", "onboarding.choose-first-runtime", "onboarding.resume-wizard", "agent-chat.chat-disabled"] as const;
export interface IdentityBoundaryContext {
  journeyKind: "browser-boundary";
  boundaryTarget: "authenticated-harness" | "empty-installed-target";
  scenario: ChatScenario; page: Page; api: RunnerApi; execution: MatrixExecution; nonce: string;
  credentials: Partial<Record<CredentialName, string>>; privateSecrets: string[]; privateDir: string; deadlineAt: number;
  evidence(name: string, value: unknown): Promise<void>;
  capture(id: string, label: string, file: string): Promise<void>;
  /** Real resources may be observed only after their supported creation. */
  observeResources(value: { companyId?: string; agentId?: string; runIds: string[] }): void;
}
export type IdentityBoundaryCase = Omit<ChatCatalogCase, "journeyKind" | "setup" | "act" | "observe" | "verifyResult" | "cleanup" | "verifySetup" | "verifyQueryRejection" | "grade"> & {
  journeyKind: "browser-boundary";
  boundaryTarget: "authenticated-harness" | "empty-installed-target";
  run(context: IdentityBoundaryContext): Promise<unknown>;
  grade(observation: unknown): ChatCatalogGrade;
  /** Mandatory owned-resource disposition, including after partial setup. */
  cleanup(context: IdentityBoundaryContext): Promise<void>;
};
