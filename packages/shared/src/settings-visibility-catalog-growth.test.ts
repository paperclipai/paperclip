import { expect, it, vi } from "vitest";

// Model a future Core release without changing the operator's policy.
vi.mock("./feature-catalog.js", async (importOriginal) => {
  const catalog = await importOriginal<typeof import("./feature-catalog.js")>();
  return { ...catalog, INSTANCE_FEATURE_KEYS: [...catalog.INSTANCE_FEATURE_KEYS, "enableFutureFeature"] };
});

import { parseHiddenSettingsList } from "./settings-visibility.js";

it("hides an added catalog feature without an operator configuration change", () => {
  const parsed = parseHiddenSettingsList("instance.plugins,instance.experimental.*,!instance.experimental.enableEnvironments");
  expect(parsed.unknown).toEqual([]);
  expect(parsed.hidden).toContain("instance.experimental.enableFutureFeature");
  expect(parsed.hidden).toContain("instance.plugins");
  expect(parsed.hidden).not.toContain("instance.experimental.enableEnvironments");
});
