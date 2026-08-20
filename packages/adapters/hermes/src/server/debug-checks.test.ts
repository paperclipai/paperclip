import { expect, test } from "vitest";
import { testEnvironment } from "./test.js";

test("debug - print checks", async () => {
  const result = await testEnvironment({
    companyId: "company-test",
    adapterType: "hermes_local",
    config: {
      hermesCommand: "python3",
      model: "openrouter/gpt-4.1-mini",
    },
  });
  console.log(JSON.stringify(result, null, 2));
  expect(result).toBeDefined();
});

test("debug - print checks with command fallback", async () => {
  const result = await testEnvironment({
    companyId: "company-test",
    adapterType: "hermes_local",
    config: {
      command: "/bin/echo",
    },
  });
  console.log(JSON.stringify(result, null, 2));
  expect(result).toBeDefined();
});
