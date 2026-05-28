import type { ConversationMapping, IdentityBinding, Platform } from "./types.js";
import { randomUUID } from "node:crypto";

export interface ConversationStore {
  findActiveMapping(
    platform: Platform,
    platformConversationId: string,
    threadId: string | null,
  ): Promise<ConversationMapping | null>;

  findByIssueId(issueId: string): Promise<ConversationMapping | null>;

  create(params: {
    platform: Platform;
    platformUserId: string;
    platformConversationId: string;
    threadId: string | null;
    paperclipIssueId: string;
    paperclipCompanyId: string;
    paperclipUserId: string;
  }): Promise<ConversationMapping>;

  updateLastActivity(id: string): Promise<void>;
  markCompleted(id: string): Promise<void>;
}

export interface IdentityStore {
  findBinding(
    platform: Platform,
    platformUserId: string,
  ): Promise<IdentityBinding | null>;

  createBinding(params: {
    platform: Platform;
    platformUserId: string;
    paperclipUserId: string;
    paperclipCompanyId: string;
  }): Promise<IdentityBinding>;
}

export class InMemoryConversationStore implements ConversationStore {
  private mappings: Map<string, ConversationMapping> = new Map();

  async findActiveMapping(
    platform: Platform,
    platformConversationId: string,
    threadId: string | null,
  ): Promise<ConversationMapping | null> {
    for (const m of this.mappings.values()) {
      if (
        m.platform === platform &&
        m.platformConversationId === platformConversationId &&
        m.threadId === threadId &&
        m.status === "active"
      ) {
        return m;
      }
    }
    return null;
  }

  async findByIssueId(issueId: string): Promise<ConversationMapping | null> {
    for (const m of this.mappings.values()) {
      if (m.paperclipIssueId === issueId) return m;
    }
    return null;
  }

  async create(params: {
    platform: Platform;
    platformUserId: string;
    platformConversationId: string;
    threadId: string | null;
    paperclipIssueId: string;
    paperclipCompanyId: string;
    paperclipUserId: string;
  }): Promise<ConversationMapping> {
    const now = new Date().toISOString();
    const mapping: ConversationMapping = {
      id: randomUUID(),
      ...params,
      status: "active",
      createdAt: now,
      lastActivityAt: now,
    };
    this.mappings.set(mapping.id, mapping);
    return mapping;
  }

  async updateLastActivity(id: string): Promise<void> {
    const m = this.mappings.get(id);
    if (m) m.lastActivityAt = new Date().toISOString();
  }

  async markCompleted(id: string): Promise<void> {
    const m = this.mappings.get(id);
    if (m) m.status = "completed";
  }
}

export class InMemoryIdentityStore implements IdentityStore {
  private bindings: Map<string, IdentityBinding> = new Map();

  private key(platform: Platform, platformUserId: string): string {
    return `${platform}:${platformUserId}`;
  }

  async findBinding(
    platform: Platform,
    platformUserId: string,
  ): Promise<IdentityBinding | null> {
    return this.bindings.get(this.key(platform, platformUserId)) ?? null;
  }

  async createBinding(params: {
    platform: Platform;
    platformUserId: string;
    paperclipUserId: string;
    paperclipCompanyId: string;
  }): Promise<IdentityBinding> {
    const binding: IdentityBinding = {
      id: randomUUID(),
      ...params,
      boundAt: new Date().toISOString(),
    };
    this.bindings.set(this.key(params.platform, params.platformUserId), binding);
    return binding;
  }
}
