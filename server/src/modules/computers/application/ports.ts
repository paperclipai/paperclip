import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import type {
  ComputerRecord,
  Ledger,
  Owner,
  ProcessClaim,
} from "../domain/ledger.js";
export interface ComputerRepository {
  create(record: ComputerRecord): Promise<void>;
  get(scope: {
    companyId: string;
    environmentId: string;
  }): Promise<ComputerRecord>;
  update<T>(
    scope: { companyId: string; environmentId: string },
    fn: (record: ComputerRecord) => T,
  ): Promise<T>;
  all(): Promise<ComputerRecord[]>;
  runState(
    scope: { companyId: string },
    runId: string,
    agentId: string,
  ): Promise<"active" | "terminal" | "missing">;
}
export interface ComputerBackend {
  inspect(record: ComputerRecord): Promise<{
    state: string;
    snapshots: boolean;
    stop: null | { id: string; status: string };
  }>;
  ready(record: ComputerRecord): Promise<void>;
  claim(record: ComputerRecord): Promise<void>;
  advance(record: ComputerRecord, owner: Owner): Promise<void>;
  runner(record: ComputerRecord): Promise<CommandManagedRuntimeRunner>;
  launch(
    record: ComputerRecord,
    owner: Owner,
    input: {
      command: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
    },
  ): Promise<ProcessClaim>;
  inspectProcess(
    record: ComputerRecord,
    owner: Owner,
  ): Promise<{ running: boolean; claim: ProcessClaim | null }>;
  retire(record: ComputerRecord, owner: Owner): Promise<void>;
  stop(record: ComputerRecord): Promise<{ id: string; status: string }>;
  stopStatus(
    record: ComputerRecord,
    id: string,
  ): Promise<{ id: string; status: string }>;
  renew(record: ComputerRecord): Promise<void>;
  desktop(
    record: ComputerRecord,
  ): Promise<{ viewerUrl: string; expiresAt: string }>;
  ingress(
    record: ComputerRecord,
    port: number,
    path: string,
  ): Promise<{ url: string; secretHeaders: Record<string, string> }>;
  preview(record: ComputerRecord, port: number): Promise<{ url: string }>;
  remote(record: ComputerRecord, input: Record<string, unknown>): Promise<any>;
}
export type { Ledger };
