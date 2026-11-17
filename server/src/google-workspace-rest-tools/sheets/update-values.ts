import { z } from "zod";
import { defineTool } from "../tool.js";
import { cellGrid, RANGE_RULES, sheetRange, spreadsheetId, spreadsheetIdInput, writeOutputSchema } from "./spreadsheet.js";
import { runValuesUpdate } from "./values-write.js";

const args = z.object({ spreadsheetId, range: sheetRange, values: cellGrid });
export type UpdateValuesArgs = z.infer<typeof args>;

export const updateValues = defineTool({
  definition: {
    name: "update_values",
    description: "Writes values into one range of a spreadsheet as raw values (Sheets valueInputOption RAW): every string is stored exactly as given, so \"=SUM(A1:A3)\" stays text, and \"2026-01-05\", \"1,000\" or \"12%\" stay text rather than becoming a date or a number. Pass numbers and booleans as JSON numbers and booleans. To write formulas, use update_formulas. null leaves a cell unchanged; an empty string clears it. Writes at most 50,000 cells per call. The result's status says which range changed and how many cells. A failed write is never retried automatically.",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: spreadsheetIdInput,
        range: { type: "string", description: `Required. The range to write, in ${RANGE_RULES} Values fill it from the top-left cell.` },
        values: {
          type: "array",
          items: { type: "array", items: {} },
          description: "Required. The values, one array per row, one item per cell. Each item is a string, number, boolean or null. null skips the cell; an empty string clears it.",
        },
      },
      required: ["spreadsheetId", "range", "values"],
    },
    outputSchema: writeOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  args,
  async run(input, http) {
    return runValuesUpdate(http, input.spreadsheetId, input.range, input.values, "RAW");
  },
});
