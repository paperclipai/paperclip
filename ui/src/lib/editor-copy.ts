type EditorCopyLocale = string | null | undefined;

const editorCopy = {
  en: {
    inlineEditor: {
      clickToEdit: "Click to edit...",
      autosaving: "Autosaving...",
      saved: "Saved",
      couldNotSave: "Could not save",
      idle: "Idle",
    },
    envEditor: {
      keyPlaceholder: "KEY",
      plain: "Plain",
      secret: "Secret",
      selectSecret: "Select secret...",
      newSecret: "New",
      valuePlaceholder: "value",
      seal: "Seal",
      secretNamePrompt: "Secret name",
      defaultSecretName: "secret",
      failedToCreateSecret: "Failed to create secret",
      createSecretTitle: "Create secret from current plain value",
      sealTitle: "Store value as secret and replace with reference",
      runtimeHint: "PAPERCLIP_* variables are injected automatically at runtime.",
    },
  },
  "zh-CN": {
    inlineEditor: {
      clickToEdit: "点击编辑…",
      autosaving: "自动保存中…",
      saved: "已保存",
      couldNotSave: "保存失败",
      idle: "空闲",
    },
    envEditor: {
      keyPlaceholder: "KEY",
      plain: "明文",
      secret: "密钥",
      selectSecret: "选择密钥…",
      newSecret: "新建",
      valuePlaceholder: "值",
      seal: "封存",
      secretNamePrompt: "密钥名称",
      defaultSecretName: "secret",
      failedToCreateSecret: "创建密钥失败",
      createSecretTitle: "根据当前明文值创建密钥",
      sealTitle: "将当前值存成密钥并替换为引用",
      runtimeHint: "PAPERCLIP_* 变量会在运行时自动注入。",
    },
  },
} as const;

function resolveLocale(locale: EditorCopyLocale) {
  return locale === "zh-CN" ? "zh-CN" : "en";
}

export function getEditorCopy(locale: EditorCopyLocale) {
  return editorCopy[resolveLocale(locale)];
}
