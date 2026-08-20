import type { UIAdapterModule } from "../types";
import {
  buildCodeBuddyLocalConfig,
  parseCodeBuddyStdoutLine,
} from "@paperclipai/adapter-codebuddy-local/ui";
import { CodeBuddyLocalConfigFields } from "./config-fields";

export const codeBuddyLocalUIAdapter: UIAdapterModule = {
  type: "codebuddy_local",
  label: "CodeBuddy",
  parseStdoutLine: parseCodeBuddyStdoutLine,
  ConfigFields: CodeBuddyLocalConfigFields,
  buildAdapterConfig: buildCodeBuddyLocalConfig,
};
