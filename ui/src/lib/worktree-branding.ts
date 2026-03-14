export type WorktreeUiBranding = {
  enabled: true;
  name: string;
  color: string;
  textColor: string;
};

function readMetaContent(name: string): string | null {
  if (typeof document === "undefined") return null;
  const element = document.querySelector(`meta[name="${name}"]`);
  const content = element?.getAttribute("content")?.trim();
  return content ? content : null;
}

function normalizeHexColor(value: string | null): string | null {
  if (!value) return null;
  const hex = value.startsWith("#") ? value.slice(1) : value;
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    return `#${hex.split("").map((char) => `${char}${char}`).join("").toLowerCase()}`;
  }
  if (/^[0-9a-fA-F]{6}$/.test(hex)) {
    return `#${hex.toLowerCase()}`;
  }
  return null;
}

function hexToRgb(color: string): { r: number; g: number; b: number } {
  const normalized = normalizeHexColor(color) ?? "#000000";
  return {
    r: Number.parseInt(normalized.slice(1, 3), 16),
    g: Number.parseInt(normalized.slice(3, 5), 16),
    b: Number.parseInt(normalized.slice(5, 7), 16),
  };
}

function relativeLuminanceChannel(value: number): number {
  const normalized = value / 255;
  return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function pickReadableTextColor(background: string): string {
  const { r, g, b } = hexToRgb(background);
  const luminance =
    (0.2126 * relativeLuminanceChannel(r)) +
    (0.7152 * relativeLuminanceChannel(g)) +
    (0.0722 * relativeLuminanceChannel(b));
  const whiteContrast = 1.05 / (luminance + 0.05);
  const blackContrast = (luminance + 0.05) / 0.05;
  return whiteContrast >= blackContrast ? "#f8fafc" : "#111827";
}

export function getWorktreeUiBranding(): WorktreeUiBranding | null {
  if (readMetaContent("paperclip-worktree-enabled") !== "true") return null;

  const name = readMetaContent("paperclip-worktree-name");
  const color = normalizeHexColor(readMetaContent("paperclip-worktree-color"));
  if (!name || !color) return null;

  return {
    enabled: true,
    name,
    color,
    textColor: normalizeHexColor(readMetaContent("paperclip-worktree-text-color")) ?? pickReadableTextColor(color),
  };
}
