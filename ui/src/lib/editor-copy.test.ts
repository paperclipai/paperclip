import { describe, expect, it } from "vitest";

import { getEditorCopy } from "./editor-copy";

describe("editor-copy", () => {
  it("returns Chinese inline editor and env editor labels", () => {
    const copy = getEditorCopy("zh-CN");

    expect(copy.inlineEditor.autosaving).toBe("自动保存中…");
    expect(copy.inlineEditor.idle).toBe("空闲");
    expect(copy.envEditor.plain).toBe("明文");
    expect(copy.envEditor.seal).toBe("封存");
    expect(copy.envEditor.runtimeHint).toBe("PAPERCLIP_* 变量会在运行时自动注入。");
  });
});
