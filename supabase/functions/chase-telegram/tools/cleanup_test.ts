import { assertEquals } from "std/testing/asserts.ts";
import { cleanTaskTitle, cleanTaskDescription } from "./cleanup.ts";

Deno.test("cleanTaskTitle removes agent prefix and capitalizes", () => {
  assertEquals(
    cleanTaskTitle("Miles: delete CRE-549?", "Miles"),
    "Delete CRE-549",
  );
});

Deno.test("cleanTaskTitle handles no assignee prefix", () => {
  assertEquals(
    cleanTaskTitle("delete CRE-549"),
    "Delete CRE-549",
  );
});

Deno.test("cleanTaskTitle removes trailing question marks", () => {
  assertEquals(
    cleanTaskTitle("review this task?"),
    "Review this task",
  );
});

Deno.test("cleanTaskTitle removes duplicate consecutive words", () => {
  assertEquals(
    cleanTaskTitle("delete delete this task"),
    "Delete this task",
  );
});

Deno.test("cleanTaskTitle handles empty string", () => {
  assertEquals(cleanTaskTitle(""), "");
});

Deno.test("cleanTaskTitle handles assignee with special regex chars", () => {
  assertEquals(
    cleanTaskTitle("(Test): do something", "(Test)"),
    "Do something",
  );
});

Deno.test("cleanTaskDescription capitalizes first letter", () => {
  assertEquals(
    cleanTaskDescription("delete CRE-549?"),
    "Delete CRE-549",
  );
});

Deno.test("cleanTaskDescription removes trailing question marks", () => {
  assertEquals(
    cleanTaskDescription("review this?"),
    "Review this",
  );
});

Deno.test("cleanTaskDescription removes duplicate words", () => {
  assertEquals(
    cleanTaskDescription("review review this"),
    "Review this",
  );
});

Deno.test("cleanTaskDescription handles empty string", () => {
  assertEquals(cleanTaskDescription(""), "");
});

Deno.test("Can you have Miles delete CRE-549? produces clean title", () => {
  const title = cleanTaskTitle("Miles: delete CRE-549?", "Miles");
  const desc = cleanTaskDescription("delete CRE-549?");

  assertEquals(title, "Delete CRE-549");
  assertEquals(desc, "Delete CRE-549");
});
