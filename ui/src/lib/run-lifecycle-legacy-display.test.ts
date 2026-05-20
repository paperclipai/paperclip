import { describe, expect, it } from "vitest";
import { agentDetailUi } from "./i18n";
import { translateLegacyRunLifecycleMessage } from "./run-lifecycle-legacy-display";

describe("run lifecycle legacy display", () => {
  it("maps common lifecycle event lines", () => {
    expect(translateLegacyRunLifecycleMessage("run started")).toBe("运行已开始");
    expect(translateLegacyRunLifecycleMessage("run succeeded")).toBe("运行成功");
    expect(translateLegacyRunLifecycleMessage("run finalized after issue closed")).toBe(
      "事务已关单，本运行已结案",
    );
  });

  it("maps through agentDetailUi.runLifecycleMessageDisplay", () => {
    expect(agentDetailUi.runLifecycleMessageDisplay("adapter invocation")).toBe("调用适配器");
    expect(
      agentDetailUi.runLifecycleMessageDisplay(
        "Cancelled because issue assignee changed before the queued run could start; the new owner will be woken instead",
      ),
    ).toContain("经办人");
  });
});
