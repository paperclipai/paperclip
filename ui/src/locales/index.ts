import en from "./en.json";
import zhCN from "./zh-CN.json";

export const messages: Record<string, Record<string, string>> = {
  en,
  "zh-CN": zhCN,
};

export type Locale = "en" | "zh-CN";
export type MessageKey = keyof typeof en;
