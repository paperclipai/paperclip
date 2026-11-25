import type { RestTool } from "../tool.js";
import { getSpreadsheet } from "./get-spreadsheet.js";
import { getValues } from "./get-values.js";
import { insertDimension } from "./insert-dimension.js";
import { updateFormulas } from "./update-formulas.js";
import { updateSpreadsheet } from "./update-spreadsheet.js";
import { updateValues } from "./update-values.js";

export const SHEETS_TOOLS: readonly RestTool[] = [
  getValues, getSpreadsheet, updateSpreadsheet, updateValues, updateFormulas, insertDimension,
];
