import { randomUUID } from "node:crypto";
import type { Issue } from "@paperclipai/plugin-sdk";
import type {
  InboundDirectMessage,
  LiveTelegramAccount,
  LoginQrPayload,
  PublicTelegramAccount,
  QrLoginHandle,
  SignedInSession,
  TelegramClientFactory,
} from "../src/types.js";

export const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
export const OTHER_COMPANY_ID = "22222222-2222-4222-8222-222222222222";
export const AGENT_ID = "33333333-3333-4333-8333-333333333333";
export const OTHER_AGENT_ID = "44444444-4444-4444-8444-444444444444";
export const MOCK_SESSION = "1AgAOMTQ3LjE1OS4xMDAuMTE1";
export const MOCK_API_HASH = "0123456789abcdef0123456789abcdef";

export function issue(input: Partial<Issue> & Pick<Issue, "id" | "companyId" | "title">): Issue {
  const now = new Date();
  const { id, companyId, title, ...rest } = input;
  return {
    id,
    companyId,
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    visibility: "open",
    privacyRootIssueId: null,
    title,
    description: null,
    status: "todo",
    workMode: "standard",
    priority: "medium",
    reviewPolicy: null,
    assigneeAgentId: null,
    responsibleUserId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: null,
    identifier: null,
    originKind: "manual",
    originId: null,
    originRunId: null,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: now,
    updatedAt: now,
    ...rest,
  };
}

export function inboundMessage(overrides: Partial<InboundDirectMessage> = {}): InboundDirectMessage {
  return {
    companyId: COMPANY_ID,
    accountId: "1001",
    peerId: "2002",
    peerName: "Sam",
    messageId: "1",
    text: "Need a quote",
    isPrivate: true,
    isGroup: false,
    isOutgoing: false,
    attachments: [],
    ...overrides,
  };
}

export type MockTelegram = {
  factory: TelegramClientFactory;
  sent: Array<{ accountId: string; peerId: string; text: string }>;
  connectFromSessionCalls: Array<{ companyId: string; session: string }>;
  startQrLoginCount: number;
  deliver(message: InboundDirectMessage): Promise<void>;
  completeLogin(account?: PublicTelegramAccount, session?: string): void;
  requirePassword(hint?: string | null): void;
  emitQr(qr?: LoginQrPayload): void;
};

export function createMockTelegram(account: PublicTelegramAccount = {
  telegramUserId: "1001",
  username: "desk",
  displayName: "Front Desk",
}): MockTelegram {
  const sent: MockTelegram["sent"] = [];
  const connectFromSessionCalls: MockTelegram["connectFromSessionCalls"] = [];
  let startQrLoginCount = 0;
  let inboundHandler: ((message: InboundDirectMessage) => Promise<void>) | null = null;
  let signedIn!: (value: SignedInSession) => void;
  let rejected!: (error: unknown) => void;
  let qrCallback: ((qr: LoginQrPayload) => void) | null = null;
  let passwordCallback: ((hint: string | null) => void) | null = null;

  const signedInPromise = new Promise<SignedInSession>((resolve, reject) => {
    signedIn = resolve;
    rejected = reject;
  });

  const live: LiveTelegramAccount = {
    account,
    companyId: COMPANY_ID,
    async sendText(peerId, text) {
      sent.push({ accountId: account.telegramUserId, peerId, text });
    },
    async disconnect() {},
  };

  const handle: QrLoginHandle = {
    async submitPassword() {},
    async waitUntilSignedIn() {
      return signedInPromise;
    },
    async abort() {
      rejected(new Error("cancelled"));
    },
  };

  const factory: TelegramClientFactory = {
    async startQrLogin(input) {
      startQrLoginCount += 1;
      qrCallback = input.onQr;
      passwordCallback = input.onPasswordRequired;
      input.onQr({ imageDataUrl: "data:image/svg+xml;utf8,qr" });
      return handle;
    },
    async connectFromSession(input) {
      connectFromSessionCalls.push({ companyId: input.companyId, session: input.session });
      inboundHandler = input.onInbound;
      live.companyId = input.companyId;
      return {
        ...live,
        account,
        companyId: input.companyId,
        async sendText(peerId, text) {
          sent.push({ accountId: account.telegramUserId, peerId, text });
        },
      };
    },
  };

  return {
    factory,
    sent,
    connectFromSessionCalls,
    get startQrLoginCount() {
      return startQrLoginCount;
    },
    async deliver(message) {
      if (!inboundHandler) throw new Error("No live inbound handler");
      await inboundHandler(message);
    },
    completeLogin(nextAccount = account, session = MOCK_SESSION) {
      signedIn({ session, account: nextAccount });
    },
    requirePassword(hint = "hint") {
      passwordCallback?.(hint);
    },
    emitQr(qr = { imageDataUrl: "data:image/svg+xml;utf8,qr" }) {
      qrCallback?.(qr);
    },
  };
}

export function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error("Timed out waiting for condition"));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

export function newId(): string {
  return randomUUID();
}
