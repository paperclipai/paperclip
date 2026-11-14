import type { CSSProperties } from "react";

const sourceRoot = "ui/src/components/task-chat/";
const surfaces: Record<string, [string, string]> = {
  "task-chat-human-bubble": ["Human message", "TaskChatBubble.tsx"],
  "task-chat-agent-bubble": ["Agent reply", "TaskChatBubble.tsx"],
  "task-chat-agent-identity": ["Agent identity", "TaskChatBubble.tsx"],
  "task-chat-live-text": ["Live commentary", "TaskChatLiveTail.tsx"],
  "task-chat-phase-interstitial": ["Activity commentary", "TaskChatRunnerActivityGroup.tsx"],
  "task-chat-thinking": ["Reasoning", "TaskChatThinking.tsx"],
  "task-chat-runner-activity-detail": ["Activity detail", "TaskChatRunnerActivityGroup.tsx"],
  "task-chat-activity-phase": ["Activity group", "TaskChatRunnerActivityGroup.tsx"],
  "task-chat-tool-card": ["Tool activity", "TaskChatToolCard.tsx"],
  "task-chat-live-run-pill": ["Run progress", "TaskChatLiveRunPill.tsx"],
  "task-chat-turn-status-header": ["Native run progress", "TaskChatRunnerTurn.tsx"],
  "task-chat-current-activity": ["Native current activity", "TaskChatRunnerTurn.tsx"],
  "task-chat-final-response": ["Native final response", "TaskChatRunnerTurn.tsx"],
  "task-chat-turn-summary": ["Activity footer", "TaskChatTurn.tsx"],
  "task-chat-system-notice": ["System notice", "TaskChatSystemNotice.tsx"],
  "task-chat-runtime-request": ["Runtime request", "TaskChatProtocolCard.tsx"],
  "task-chat-runtime-request-history": ["Request receipt", "TaskChatProtocolCard.tsx"],
  "task-chat-composer-takeover": ["Composer request", "TaskChatComposer.tsx"],
  "task-chat-composer-input": ["Composer input", "TaskChatComposer.tsx"],
  "task-chat-composer-actions": ["Composer controls", "TaskChatComposer.tsx"],
  "paused-composer-takeover": ["Paused composer", "TaskChatPausedTakeover.tsx"],
  "task-chat-collapsible-marker": ["Run outcome", "TaskChatMarker.tsx"],
};
export type ConversationTypeRole = {
  key: string; name: string; area: string; text: string; sampleStyle: CSSProperties;
  family: string; size: string; leading: string; weight: string; color: string;
  tracking: string; emphasis: string; opacity: string; metricKey: string;
  states: string[]; sources: string[]; recipes: string[];
};
export type ConversationTypeInventory = { roles: ConversationTypeRole[]; states: string[]; capturedAt: string };

/** Inspect text already mounted by the shared sandbox composition. No imitation
 * renderer or hardcoded font metrics; closed disclosures stay out of the census. */
export function measureConversationType(root: HTMLElement): ConversationTypeInventory {
  const roles = new Map<string, ConversationTypeRole>();
  const cases = [...root.querySelectorAll<HTMLElement>("[data-preview-case]")];
  for (const example of cases) {
    const walker = document.createTreeWalker(example, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const parent = node.parentElement;
      const text = node.textContent?.replace(/\s+/g, " ").trim();
      if (!text || !parent || parent.closest('[aria-hidden="true"], .sr-only, svg, script, style') || !parent.getClientRects().length) continue;
      if (parent === example.firstElementChild && parent.tagName === "H3") continue;
      const computed = getComputedStyle(parent);
      if (computed.visibility !== "visible" || computed.opacity === "0") continue;
      let area = "Conversation support";
      let source = "ui/src/components/design-sandbox/DesignSandboxTaskThread.tsx";
      const recipes: string[] = [];
      let opacity = 1;
      for (let ancestor: HTMLElement | null = parent; ancestor && ancestor !== example; ancestor = ancestor.parentElement) {
        opacity *= Number(getComputedStyle(ancestor).opacity);
        if (ancestor.classList.length) recipes.push(`${ancestor.tagName.toLowerCase()}.${[...ancestor.classList].join(".")}`);
        const id = ancestor.dataset.testid;
        if (id && surfaces[id] && area === "Conversation support") {
          [area, source] = [surfaces[id][0], sourceRoot + surfaces[id][1]];
        }
        if (id && /^(task-chat-provider-|task-chat-workspace-|task-chat-run-result|task-chat-run-terminal|task-chat-resource-)/.test(id) && area === "Conversation support") {
          [area, source] = ["Structured activity", sourceRoot + "TaskChatProtocolCard.tsx"];
        }
      }
      if (!opacity) continue;
      const semantic = parent.closest("code, pre, strong, b, em, i, a, blockquote, h1, h2, h3, h4, h5, h6, li, button, label, textarea, p");
      const tag = semantic?.tagName.toLowerCase();
      const form = parent.closest("button") ? "Control label" : tag === "code" || tag === "pre" ? "Code / command" : tag === "strong" || tag === "b" ? "Strong emphasis" : tag === "em" || tag === "i" ? "Italic emphasis" : tag === "a" ? "Link" : tag === "li" ? "List text" : tag === "p" ? "Body text" : tag?.startsWith("h") ? "Heading" : /^\d{1,2}:\d\d [AP]M$/.test(text) ? "Timestamp" : "Supporting text";
      const values = {
        family: computed.fontFamily, size: computed.fontSize, leading: computed.lineHeight,
        weight: computed.fontWeight, color: computed.color, tracking: computed.letterSpacing,
        emphasis: `${computed.fontStyle} / ${computed.textDecorationLine}`, opacity: String(Number(opacity.toFixed(3))),
      };
      const metricKey = JSON.stringify([values.family, values.size, values.leading, values.weight, values.tracking, computed.fontStyle]);
      const key = JSON.stringify([area, form, values]);
      const state = example.dataset.previewCase!;
      const role = roles.get(key) ?? {
        key, metricKey, name: `${area} · ${form.toLowerCase()}`, area, text, ...values,
        sampleStyle: { fontFamily: values.family, fontSize: values.size, lineHeight: values.leading, fontWeight: values.weight, color: values.color, letterSpacing: values.tracking, fontStyle: computed.fontStyle, textDecorationLine: computed.textDecorationLine, opacity: values.opacity },
        states: [], sources: [], recipes: [],
      };
      if (!role.states.includes(state)) role.states.push(state);
      if (!role.sources.includes(source)) role.sources.push(source);
      if (parent.closest(".paperclip-markdown") && !role.sources.includes("ui/src/index.css · .paperclip-markdown")) role.sources.push("ui/src/index.css · .paperclip-markdown");
      if (role.recipes.length === 0) role.recipes = recipes;
      roles.set(key, role);
    }
  }
  return { roles: [...roles.values()].sort((a, b) => a.area.localeCompare(b.area) || parseFloat(b.size) - parseFloat(a.size) || a.name.localeCompare(b.name)), states: cases.map(example => example.dataset.previewCase!), capturedAt: new Date().toLocaleTimeString() };
}
