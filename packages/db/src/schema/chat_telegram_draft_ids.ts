import { pgSequence } from "drizzle-orm/pg-core";

// Telegram Stop updates contain a draft ID but no actor or generation. This
// content-free instance sequence must survive endpoint/company deletion and
// transaction rollback, so an old Stop can never name a newly allocated draft.
// Do not attach it to a table or cycle/reset it when clearing chat records.
export const chatTelegramDraftIds = pgSequence("chat_telegram_draft_ids", {
  startWith: 1,
  minValue: 1,
  maxValue: 2_147_483_647,
  increment: 1,
  cache: 1,
  cycle: false,
});
