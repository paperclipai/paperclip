import type { RestTool } from "../tool.js";
import { createDraft } from "./create-draft.js";
import { getDraft } from "./get-draft.js";
import { getMessage } from "./get-message.js";
import { getThread } from "./get-thread.js";
import { listDrafts } from "./list-drafts.js";
import { listLabels } from "./list-labels.js";
import { listThreads } from "./list-threads.js";
import { searchMessages } from "./search-messages.js";
import { searchThreads } from "./search-threads.js";

export const GMAIL_TOOLS: readonly RestTool[] = [
  getMessage,
  searchThreads,
  createDraft,
  getThread,
  getDraft,
  listDrafts,
  listLabels,
  listThreads,
  searchMessages,
];
