// The installed Codex dependency takes precedence over PATH. Pin only this
// acceptance server's command resolver to its deterministic protocol fixture.
import { accessSync, constants } from "node:fs";
import { registerHooks } from "node:module";
import { isAbsolute } from "node:path";

const command = process.env.PAPERCLIP_STOP_CODEX_COMMAND;
if (process.env.NODE_ENV !== "test" || !command || !isAbsolute(command)) {
  throw new Error("Composer Stop requires an absolute fixture command in NODE_ENV=test");
}
accessSync(command, constants.X_OK);
registerHooks({
  load(url, context, nextLoad) {
    if (/\/packages\/paperclip-runner\/(src|dist)\/drivers\/codex\/codex-command\.(js|ts)$/.test(url)) {
      return {
        format: "module",
        shortCircuit: true,
        source: `export const resolveCodexCommand = () => ${JSON.stringify(command)}; export const resolvePinnedCodexCommand = resolveCodexCommand;`,
      };
    }
    return nextLoad(url, context);
  },
});
