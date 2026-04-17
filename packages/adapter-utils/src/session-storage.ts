import { ConversationContext, ConversationTurn } from './conversation-history.js';

export interface SessionStore {
  saveSession(sessionId: string, context: ConversationContext): Promise<void>;
  loadSession(sessionId: string): Promise<ConversationContext | null>;
  appendTurn(sessionId: string, turn: ConversationTurn): Promise<void>;
  clearSession(sessionId: string): Promise<void>;
}

export function createInMemorySessionStore(): SessionStore {
  // For local/testing use — store in RAM
  // Session lost on restart
  const sessions = new Map<string, ConversationContext>();

  return {
    async saveSession(id, ctx) { sessions.set(id, ctx); },
    async loadSession(id) { return sessions.get(id) ?? null; },
    async appendTurn(id, turn) {
      const ctx = sessions.get(id);
      if (ctx) ctx.turns.push(turn);
    },
    async clearSession(id) { sessions.delete(id); },
  };
}

export function createSqliteSessionStore(dbPath: string): SessionStore {
  // For production use — persist to SQLite
  // SessionId → compressed JSON blob of conversation history

  // Note: This is a placeholder. In real implementation, you'd use better-sqlite3
  // For now, we'll use in-memory as fallback
  console.warn('SQLite session store not implemented, using in-memory fallback');
  return createInMemorySessionStore();
}