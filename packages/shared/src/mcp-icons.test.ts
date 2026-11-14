import { describe, expect, it } from "vitest";
import {
  MCP_ICON_MAX_COUNT,
  MCP_ICON_MAX_DATA_URI_LENGTH,
  pickMcpIcon,
  readMcpIcons,
  sanitizeMcpIconSrc,
} from "./mcp-apps.js";

const PNG = "https://cdn.example.com/icons/tool.png";
const SVG_DATA = "data:image/svg+xml;base64,PHN2Zy8+";

describe("sanitizeMcpIconSrc", () => {
  it("keeps https raster images and data:image URIs, including inline SVG", () => {
    expect(sanitizeMcpIconSrc(PNG)).toBe(PNG);
    expect(sanitizeMcpIconSrc(SVG_DATA)).toBe(SVG_DATA);
    expect(sanitizeMcpIconSrc("data:image/png;base64,iVBORw0KGgo=")).toBe("data:image/png;base64,iVBORw0KGgo=");
  });

  it("drops other schemes, remote SVG, credentials and oversize data", () => {
    expect(sanitizeMcpIconSrc("http://cdn.example.com/tool.png")).toBeNull();
    expect(sanitizeMcpIconSrc("javascript:alert(1)")).toBeNull();
    expect(sanitizeMcpIconSrc("data:text/html;base64,PHNjcmlwdD4=")).toBeNull();
    expect(sanitizeMcpIconSrc("https://cdn.example.com/tool.svg")).toBeNull();
    expect(sanitizeMcpIconSrc("https://cdn.example.com/tool", "image/svg+xml")).toBeNull();
    expect(sanitizeMcpIconSrc("https://user:pw@cdn.example.com/tool.png")).toBeNull();
    expect(sanitizeMcpIconSrc(`data:image/png;base64,${"A".repeat(MCP_ICON_MAX_DATA_URI_LENGTH)}`)).toBeNull();
    expect(sanitizeMcpIconSrc(42)).toBeNull();
  });
});

describe("readMcpIcons", () => {
  it("keeps valid icons with their metadata and drops the rest", () => {
    expect(readMcpIcons([
      { src: PNG, mimeType: "image/png", sizes: ["32x32", "bogus"], theme: "dark" },
      { src: "http://insecure.example.com/a.png" },
      { src: "https://cdn.example.com/b", mimeType: "text/html" },
      { src: SVG_DATA, mimeType: "image/svg+xml", theme: "neon" },
    ])).toEqual([
      { src: PNG, mimeType: "image/png", sizes: ["32x32"], theme: "dark" },
      { src: SVG_DATA, mimeType: "image/svg+xml" },
    ]);
  });

  it("bounds the count and returns null when nothing survives", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ src: `https://cdn.example.com/${i}.png` }));
    expect(readMcpIcons(many)).toHaveLength(MCP_ICON_MAX_COUNT);
    expect(readMcpIcons([{ src: "javascript:1" }])).toBeNull();
    expect(readMcpIcons("nope")).toBeNull();
    expect(readMcpIcons(undefined)).toBeNull();
  });
});

describe("pickMcpIcon", () => {
  it("prefers the theme's icon and a size near 32px", () => {
    const icons = [
      { src: "https://a.example.com/light.png", theme: "light" as const },
      { src: "https://a.example.com/dark-512.png", theme: "dark" as const, sizes: ["512x512"] },
      { src: "https://a.example.com/dark-32.png", theme: "dark" as const, sizes: ["32x32"] },
    ];
    expect(pickMcpIcon(icons, "dark")?.src).toBe("https://a.example.com/dark-32.png");
    expect(pickMcpIcon(icons, "light")?.src).toBe("https://a.example.com/light.png");
    expect(pickMcpIcon(null, "light")).toBeNull();
  });
});
