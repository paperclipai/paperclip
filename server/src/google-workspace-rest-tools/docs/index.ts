import type { RestTool } from "../tool.js";
import { readDoc } from "./read-doc.js";
import { updateDoc } from "./update-doc.js";

export const DOCS_TOOLS: readonly RestTool[] = [readDoc, updateDoc];
