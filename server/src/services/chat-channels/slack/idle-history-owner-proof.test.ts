import { expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { idleChatHistoryChecks, idleChatHistoryChecksForOwner } from "../idle-history-proof.js";
it("absence retains the exact existing chat history query objects", () => {
  expect(idleChatHistoryChecksForOwner()).toBe(idleChatHistoryChecks);
  expect(idleChatHistoryChecksForOwner([])).toBe(idleChatHistoryChecks);
});
it("the same validated bound action identity appears in action and delivery queries with normal graph checks", () => {
  const id = "11111111-1111-4111-8111-111111111111", checks = idleChatHistoryChecksForOwner([id, id]);
  for (const reason of ["chat_actions", "chat_deliveries"]) {
    const check = checks.find(check => check.reason === reason); if (!check || typeof check.query === "string") throw new Error("Parameterized owner query missing");
    const rendered = new PgDialect().sqlToQuery(check.query);
    expect(rendered.params).toEqual([[id]]);
    expect(rendered.sql).not.toContain(id);
    expect(rendered.sql).toContain("e.company_id = a.company_id");
    expect(rendered.sql).toContain("d.company_id = a.company_id");
    expect(rendered.sql).toContain("unnest($1::uuid[])");
  }
  expect(() => idleChatHistoryChecksForOwner(["foreign' OR true"])).toThrow();

});

it("retained completion identity counts do not become SQL literal or parameter ceilings",()=>{
  const ids=Array.from({length:65536},(_,index)=>`11111111-1111-4111-8111-${String(index).padStart(12,"0")}`);
  const check=idleChatHistoryChecksForOwner(ids).find(value=>value.reason==="chat_actions");
  if(!check||typeof check.query==="string")throw new Error("Parameterized owner query absent");
  const rendered=new PgDialect().sqlToQuery(check.query);
  expect(rendered.params).toEqual([ids]);expect(rendered.sql).not.toContain(ids[0]);
  expect(rendered.sql).toContain("unnest($1::uuid[])");
});
