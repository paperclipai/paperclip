export { sessionCodec } from "./session.js";
export { execute } from "./execute.js";
export { testEnvironment } from "./test.js";
export {
  MUSE_DEVICE_LOGIN_COMMAND,
  parseMuseDeviceLoginPrompt,
  type MuseDeviceLoginPrompt,
} from "./device-login-parse.js";

export const loginCapability = {
  panelMode: "displayed_code" as const,
  timeoutPolicy: "caller_bounded" as const,
  getCommand: () => "muse login",
  parsePrompt: (output: string) => {
    const urlMatch = output.match(/https?:\/\/[^\s]+/);
    const codeMatch = output.match(/code:\s*([A-Z0-9-]+)/i) || output.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/);
    if (!urlMatch || !codeMatch) return null;
    return {
      url: urlMatch[0],
      code: codeMatch[1],
    };
  },
};

export { listMuseSkills, syncMuseSkills } from "./skills.js";
export { decideMuseAuthMerge } from "./muse-auth-merge-decision.js";
