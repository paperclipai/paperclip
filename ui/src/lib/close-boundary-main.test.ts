import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
it("forwards global mutation error presentation through the actual main bridge without side effects", () => {
  const source = readFileSync(new URL("../main.tsx", import.meta.url), "utf8");
  const line = source.split("\n").find(line => line.trim().startsWith("notifyMutationError:"))!;
  const expression = line.trim().replace(/^notifyMutationError:\s*/, "").replace(/,$/, "");
  const push = vi.fn(); const notify = new Function("pushMutationErrorToast", `return (${expression})`)(push);
  const error = new Error("Raw diagnostic"); const presentation = { error: { cause: error } };
  notify({ title: "Title", body: "Body", presentation });
  expect(push).toHaveBeenCalledExactlyOnceWith({ title: "Title", body: "Body", presentation, tone: "error" });
  new Function("pushMutationErrorToast", `return (${expression})`)(null)({ title: "Early", body: "Before provider", presentation });
  expect(push).toHaveBeenCalledTimes(1);
  // Startup invariant is pre-React diagnostic, not a toast or visible copy.
  expect(source).toContain('if (!rootElement) throw new Error("Paperclip root element is missing");');
});
