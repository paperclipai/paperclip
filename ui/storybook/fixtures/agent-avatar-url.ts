import { agentAvatarUrl as apiAvatarUrl } from "@paperclipai/shared";

/** Resolve against iframe.html so CSS backgrounds also work under hosted branch prefixes. */
export const agentAvatarUrl: typeof apiAvatarUrl = (...args) => {
  const url = new URL(apiAvatarUrl(...args), "https://storybook.invalid");
  const preset = url.pathname.slice("/api/agent-avatars/".length).replace(/\.png$/, "");
  const path = `./agent-avatar-images/${preset}-${url.searchParams.get("size")}-${url.searchParams.get("scale")}.png`;
  // The build-time asset packer needs relative file names. Browser consumers
  // need absolute URLs because CSS custom properties use the stylesheet base.
  return typeof document === "undefined" ? path : new URL(path, document.baseURI).href;
};
