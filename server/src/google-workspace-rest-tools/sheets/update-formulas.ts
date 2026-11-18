import { z } from "zod";
import { defineTool } from "../tool.js";
import { cellGrid, RANGE_RULES, sheetRange, spreadsheetId, spreadsheetIdInput, writeOutputSchema } from "./spreadsheet.js";
import { runValuesUpdate } from "./values-write.js";

const args = z.object({ spreadsheetId, range: sheetRange, formulas: cellGrid });
export type UpdateFormulasArgs = z.infer<typeof args>;

export const updateFormulas = defineTool({
  definition: {
    name: "update_formulas",
    description: "Writes formulas into one range of a spreadsheet. Each item is entered as if typed into Google Sheets (Sheets valueInputOption USER_ENTERED): a string starting with = becomes a formula, such as \"=SUM(A1:A3)\" or \"=VLOOKUP(B2,Prices!A:B,2,FALSE)\"; other text may be turned into a number or date by the spreadsheet's locale. Use update_values to store text exactly as given. null leaves a cell unchanged; an empty string clears it. Writes at most 50,000 cells per call. The result's status says which range changed and how many cells. A failed write is never retried automatically.",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: spreadsheetIdInput,
        range: { type: "string", description: `Required. The range to write, in ${RANGE_RULES} Formulas fill it from the top-left cell.` },
        formulas: {
          type: "array",
          items: { type: "array", items: {} },
          description: "Required. The formulas, one array per row, one item per cell, for example [[\"=A1+B1\"], [\"=A2+B2\"]]. Items may also be numbers, booleans or null. null skips the cell; an empty string clears it.",
        },
      },
      required: ["spreadsheetId", "range", "formulas"],
    },
    outputSchema: writeOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  args,
  async run(input, http) {
    return runValuesUpdate(http, input.spreadsheetId, input.range, input.formulas, "USER_ENTERED");
  },
});
