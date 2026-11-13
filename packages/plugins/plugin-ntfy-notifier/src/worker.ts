import { definePlugin, runWorker, type PluginEvent, type PluginEventType } from "@paperclipai/plugin-sdk";
import { parseConfig } from "./config.js";
import { DecisionNotifier } from "./notifier.js";
import { BLOCKER_ATTENTION_CHANGED, DECISION_CREATED, INTERACTION_CREATED } from "./triggers.js";

/**
 * Event names the notifier listens to. Each name is registered exactly once:
 * some hosts deliver one notification per registration, so registering a
 * name twice would multiply deliveries.
 *
 * `issue.thread_interaction_created`, `issue.blocker_attention_changed` and
 * `decision.created` are not in the host's plugin event registry on every
 * host. Subscribing is harmless where they are not emitted, and the handler
 * starts receiving them once the host does.
 */
export const SUBSCRIBED_EVENTS = [
  "approval.created",
  INTERACTION_CREATED,
  "activity.logged",
  "issue.updated",
  BLOCKER_ATTENTION_CHANGED,
  DECISION_CREATED,
] as const;

const plugin = definePlugin({
  multiCompanyConfig: true,

  async setup(ctx) {
    const notifier = new DecisionNotifier(ctx);
    const handler = async (event: PluginEvent) => {
      await notifier.handle(event);
    };
    for (const name of SUBSCRIBED_EVENTS) {
      ctx.events.on(name as PluginEventType, handler);
    }
  },

  async onValidateConfig(config) {
    const parsed = parseConfig(config);
    return parsed.ok ? { ok: true } : { ok: false, errors: parsed.errors };
  },

  async onHealth() {
    return { status: "ok", message: "ntfy notifier ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
