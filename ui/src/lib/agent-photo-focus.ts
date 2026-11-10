import { normalizeAgentAvatarFocus, type AgentAvatarFocus } from "@paperclipai/shared";

export interface AvatarFocusDrag {
  start: AgentAvatarFocus;
  deltaX: number;
  deltaY: number;
  containerSize: number;
  imageWidth: number;
  imageHeight: number;
}

export function avatarFocusFromDrag(input: AvatarFocusDrag): AgentAvatarFocus {
  const container = input.containerSize;
  if (!(container > 0) || !(input.imageWidth > 0) || !(input.imageHeight > 0)) return normalizeAgentAvatarFocus(input.start);
  const scale = Math.max(container / input.imageWidth, container / input.imageHeight);
  return normalizeAgentAvatarFocus({
    x: pan(input.start.x, input.deltaX, container - input.imageWidth * scale),
    y: pan(input.start.y, input.deltaY, container - input.imageHeight * scale),
  });
}

function pan(startPercent: number, delta: number, overflow: number): number {
  if (overflow >= -0.5) return startPercent;
  const startOffset = overflow * (Math.min(100, Math.max(0, startPercent)) / 100);
  return Math.min(100, Math.max(0, ((startOffset + delta) / overflow) * 100));
}
