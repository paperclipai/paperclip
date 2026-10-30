import {
  and,
  eq,
} from "drizzle-orm";

import type { Db } from "@paperclipai/db";

import {
  chatSdkState,
} from "@paperclipai/db";

import type {
  ChatSdkStateCompareAndSetInput,
  ChatSdkStateDeleteInput,
  ChatSdkStatePersistence,
  ChatSdkStateScope,
} from "../chat-sdk-state.js";

export function createChatSdkStatePersistence(db: Db): ChatSdkStatePersistence {
  return {
    async read(scope: ChatSdkStateScope, key: string) {
      return db
        .select({
          value: chatSdkState.value,
          version: chatSdkState.version,
          expiresAt: chatSdkState.expiresAt,
        })
        .from(chatSdkState)
        .where(
          and(
            eq(chatSdkState.companyId, scope.companyId),
            eq(chatSdkState.endpointId, scope.endpointId),
            eq(chatSdkState.stateKey, key),
          ),
        )
        .then((rows) => rows[0] ?? null);
    },
    async compareAndSet(input: ChatSdkStateCompareAndSetInput) {
      if (input.expectedVersion === null) {
        const inserted = await db
          .insert(chatSdkState)
          .values({
            companyId: input.companyId,
            endpointId: input.endpointId,
            stateKey: input.key,
            version: 1,
            value: input.value,
            expiresAt: input.expiresAt,
          })
          .onConflictDoNothing()
          .returning({ id: chatSdkState.id });
        return inserted.length === 1;
      }
      const updated = await db
        .update(chatSdkState)
        .set({
          version: input.expectedVersion + 1,
          value: input.value,
          expiresAt: input.expiresAt,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chatSdkState.companyId, input.companyId),
            eq(chatSdkState.endpointId, input.endpointId),
            eq(chatSdkState.stateKey, input.key),
            eq(chatSdkState.version, input.expectedVersion),
          ),
        )
        .returning({ id: chatSdkState.id });
      return updated.length === 1;
    },
    async deleteIfVersion(input: ChatSdkStateDeleteInput) {
      const deleted = await db
        .delete(chatSdkState)
        .where(
          and(
            eq(chatSdkState.companyId, input.companyId),
            eq(chatSdkState.endpointId, input.endpointId),
            eq(chatSdkState.stateKey, input.key),
            eq(chatSdkState.version, input.expectedVersion),
          ),
        )
        .returning({ id: chatSdkState.id });
      return deleted.length === 1;
    },
  };
}
