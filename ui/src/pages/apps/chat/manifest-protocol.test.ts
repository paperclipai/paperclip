import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("keeps Teams manifest permission types canonical in every UI locale", () => {
  const source = readFileSync(new URL("./ChatEndpointSetup.tsx", import.meta.url), "utf8");
  expect(source).toContain('{ name: "ChannelMessage.Read.Group", type: "Application" }');
  expect(source).toContain('{ name: "ChatMessage.Read.Chat", type: "Application" }');
  expect(source).not.toContain('type: t("localizationTools.application15")');
});
