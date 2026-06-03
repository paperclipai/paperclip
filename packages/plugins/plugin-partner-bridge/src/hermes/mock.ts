import type { HermesConnector, SendMessage } from "./types.js";

export class MockHermesConnector implements HermesConnector {
  sent: SendMessage[] = [];
  async send(msg: SendMessage): Promise<void> { this.sent.push(msg); }
}
