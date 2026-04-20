import { definePlugin, runWorker, type PluginContext } from "@paperclipai/plugin-sdk";
import {
  parseConfiguredTargets,
  syncConfiguredDriveTargets,
  validateDriveContextConfig,
} from "./drive.js";

let pluginContext: PluginContext | null = null;

const plugin = definePlugin({
  async setup(ctx) {
    pluginContext = ctx;
    ctx.jobs.register("sync-drive-folders", async () => {
      await syncConfiguredDriveTargets(ctx);
    });
    ctx.logger.info("Google Drive context example plugin ready");
  },

  async onHealth() {
    if (!pluginContext) {
      return { status: "degraded", message: "Google Drive context plugin is starting." };
    }
    const config = await pluginContext.config.get();
    const validation = validateDriveContextConfig(config);
    if (!validation.ok) {
      return {
        status: "degraded",
        message: validation.errors.join(" "),
        details: { targetCount: validation.targetCount },
      };
    }
    return {
      status: "ok",
      message: `Google Drive context plugin ready for ${validation.targetCount} target(s).`,
      details: { targetCount: validation.targetCount },
    };
  },

  async onValidateConfig(config) {
    const validation = validateDriveContextConfig(config);
    return {
      ok: validation.ok,
      errors: validation.errors,
      warnings: validation.warnings,
    };
  },

  async onConfigChanged(newConfig) {
    const targets = parseConfiguredTargets(newConfig);
    pluginContext?.logger.info("Google Drive context config updated", { targetCount: targets.length });
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
