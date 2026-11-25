import type { RestTool } from "../tool.js";
import { readPresentation } from "./read-presentation.js";
import { updatePresentation } from "./update-presentation.js";

export const SLIDES_TOOLS: readonly RestTool[] = [readPresentation, updatePresentation];
