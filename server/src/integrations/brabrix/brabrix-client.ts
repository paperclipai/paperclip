import type { BrabrixConfig } from "./brabrix-config.js";
import type {
  BrabrixCompleteTaskInput,
  BrabrixProjectContext,
  BrabrixSendRunLogsInput,
  BrabrixTask,
} from "./brabrix-types.js";

export class BrabrixClient {
  constructor(
    private readonly config: BrabrixConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async getProjectContext(): Promise<BrabrixProjectContext | null> {
    void this.config;
    void this.fetcher;
    throw new Error("BrabrixClient.getProjectContext is not implemented yet.");
  }

  async getNextTask(): Promise<BrabrixTask | null> {
    void this.config;
    void this.fetcher;
    throw new Error("BrabrixClient.getNextTask is not implemented yet.");
  }

  async sendRunLogs(_input: BrabrixSendRunLogsInput): Promise<void> {
    void this.config;
    void this.fetcher;
    throw new Error("BrabrixClient.sendRunLogs is not implemented yet.");
  }

  async completeTask(_input: BrabrixCompleteTaskInput): Promise<void> {
    void this.config;
    void this.fetcher;
    throw new Error("BrabrixClient.completeTask is not implemented yet.");
  }
}
