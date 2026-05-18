import { definePlugin } from "@paperclipai/plugin-sdk";
import { registerGetIssueTool } from "./tools/get-issue.js";
import { registerTransitionTool } from "./tools/transition.js";
import { registerAssignIssueTool } from "./tools/assign-issue.js";
import { registerGetTransitionsTool } from "./tools/get-transitions.js";

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("Atlassian Jira plugin ready");
    registerGetIssueTool(ctx);
    registerTransitionTool(ctx);
    registerAssignIssueTool(ctx);
    registerGetTransitionsTool(ctx);
  },

  async onHealth() {
    return { status: "ok", message: "Atlassian Jira plugin healthy" };
  },
});

export default plugin;
