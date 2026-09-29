import { agentAvatarUrl as apiAvatarUrl } from "@paperclipai/shared";

/** Relative to iframe.html, including when a preview is hosted under a branch prefix. */
export const agentAvatarUrl: typeof apiAvatarUrl = (...args) => {
  const url = new URL(apiAvatarUrl(...args), "https://storybook.invalid");
  const preset = url.pathname.slice("/api/agent-avatars/".length).replace(/\.png$/, "");
  return `./agent-avatar-images/${preset}-${url.searchParams.get("size")}-${url.searchParams.get("scale")}.png`;
};
