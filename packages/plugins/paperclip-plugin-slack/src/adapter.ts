import type { PluginContext } from "@paperclipai/plugin-sdk";
import { postMessage, updateMessage } from "./slack-api.js";

export class SlackAdapter {
  private ctx: PluginContext;
  private token: string;

  constructor(ctx: PluginContext, token: string) {
    this.ctx = ctx;
    this.token = token;
  }

  async sendText(
    channelId: string,
    text: string,
    opts?: { threadTs?: string },
  ): Promise<{ ok: boolean; ts?: string }> {
    return postMessage(
      this.ctx,
      this.token,
      channelId,
      {
        text,
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text },
          },
        ],
      },
      opts,
    );
  }

  async sendButtons(
    channelId: string,
    text: string,
    buttons: Array<{
      label: string;
      actionId: string;
      value: string;
      style?: "primary" | "danger";
    }>,
    opts?: { threadTs?: string },
  ): Promise<{ ok: boolean; ts?: string }> {
    const elements = buttons.map((btn) => {
      const el: Record<string, unknown> = {
        type: "button",
        text: { type: "plain_text", text: btn.label },
        action_id: btn.actionId,
        value: btn.value,
      };
      if (btn.style) {
        el.style = btn.style;
      }
      return el;
    });
    return postMessage(
      this.ctx,
      this.token,
      channelId,
      {
        text,
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text },
          },
          {
            type: "actions",
            elements,
          },
        ],
      },
      opts,
    );
  }

  async editMessage(
    channelId: string,
    ts: string,
    text: string,
    blocks?: Array<Record<string, unknown>>,
  ): Promise<{ ok: boolean }> {
    return updateMessage(this.ctx, this.token, channelId, ts, { text, blocks });
  }

  formatAgentLabel(agentName: string): string {
    return `*[${agentName}]*`;
  }

  formatMention(userId: string): string {
    return `<@${userId}>`;
  }

  formatCodeBlock(code: string): string {
    return `\`\`\`${code}\`\`\``;
  }
}
