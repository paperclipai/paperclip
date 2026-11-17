import type { RestTool } from "../tool.js";
import { createDraft } from "./create-draft.js";
import { getMessage } from "./get-message.js";
import { searchThreads } from "./search-threads.js";

export const GMAIL_TOOLS: readonly RestTool[] = [getMessage, searchThreads, createDraft];
