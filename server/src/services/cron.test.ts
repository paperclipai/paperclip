import { describe, expect, it } from "vitest";
import { nextCronTickFromExpression, parseCron, validateCron } from "./cron.js";

describe("cron numeric fields", () => {
  const malformed = [
    "1abc", "1.5", "*/2.5", "*/2/3", "1-3-5", "1-3x",
    "1-5/2x", "1x/2", "1e1", "1,2oops", "1-3-5/2",
  ];

  for (const [index, field] of ["minute", "hour", "day of month", "month", "day of week"].entries()) {
    it.each(malformed)(`rejects unsupported ${field} syntax: %s`, (token) => {
      const fields = ["0", "0", "*", "*", "*"];
      fields[index] = token;
      const expression = fields.join(" ");
      expect(validateCron(expression)).not.toBeNull();
      expect(() => parseCron(expression)).toThrow();
      expect(() => nextCronTickFromExpression(expression, new Date("2026-10-23T10:00:00Z"))).toThrow();
    });
  }

  it.each([
    ["01 02 03 04 05", [[1], [2], [3], [4], [5]]],
    ["01,03-05/02 02-04 03,05 04-06/02 00,02-04/02", [[1, 3, 5], [2, 3, 4], [3, 5], [4, 6], [0, 2, 4]]],
    ["05/20 01/08 01/10 01/04 00/03", [[5, 25, 45], [1, 9, 17], [1, 11, 21, 31], [1, 5, 9], [0, 3, 6]]],
    ["*/15 */6 */10 */3 */2", [[0, 15, 30, 45], [0, 6, 12, 18], [1, 11, 21, 31], [1, 4, 7, 10], [0, 2, 4, 6]]],
    ["0,59 0,23 1,31 1,12 0,6", [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]]],
    ["5,1,5,3 2,1,2 4,3,4 2,1,2 1,0,1", [[1, 3, 5], [1, 2], [3, 4], [1, 2], [0, 1]]],
    ["1-3 1-3 1-3 1-3 1-3", [[1, 2, 3], [1, 2, 3], [1, 2, 3], [1, 2, 3], [1, 2, 3]]],
  ] as const)("preserves integer fields: %s", (expression, expected) => {
    expect(validateCron(expression)).toBeNull();
    const parsed = parseCron(expression);
    expect([parsed.minutes, parsed.hours, parsed.daysOfMonth, parsed.months, parsed.daysOfWeek]).toEqual(expected);
  });

  it("preserves complete wildcard fields", () => {
    const parsed = parseCron("* * * * *");
    expect(validateCron("* * * * *")).toBeNull();
    expect(Object.values(parsed).map(values => [values.length, values[0], values.at(-1)]))
      .toEqual([[60, 0, 59], [24, 0, 23], [31, 1, 31], [12, 1, 12], [7, 0, 6]]);
  });

  it.each([
    ["*/15 * * * *", "2026-10-23T10:00:00Z", "2026-10-23T10:15:00.000Z"],
    ["05/20 * * * *", "2026-10-23T10:00:00Z", "2026-10-23T10:05:00.000Z"],
    ["0 0 29 2 *", "2025-03-01T00:00:00Z", "2028-02-29T00:00:00.000Z"],
    ["0 0 * * 0", "2026-10-23T10:00:00Z", "2026-10-25T00:00:00.000Z"],
    ["0 0 1 * 1", "2026-10-23T10:00:00Z", "2027-02-01T00:00:00.000Z"],
  ])("preserves the next UTC tick for %s", (expression, after, expected) => {
    expect(nextCronTickFromExpression(expression, new Date(after))?.toISOString()).toBe(expected);
  });

  it.each([
    "60 * * * *", "0 24 * * *", "0 0 0 * *", "0 0 * 13 *", "0 0 * * 7",
    "*/0 * * * *", "5-1 * * * *", "1,,2 * * * *", "* * * *", "*x * * * *",
  ])("keeps rejecting invalid input: %s", (expression) => {
    expect(validateCron(expression)).not.toBeNull();
    expect(() => parseCron(expression)).toThrow();
  });
});
