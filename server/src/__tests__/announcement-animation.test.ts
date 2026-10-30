import { describe, expect, it } from "vitest";
import { validateAnnouncementAnimation } from "../services/announcement-animation.js";

describe("announcement animation documents", () => {
  it("preserves CSS keyframes and visual HTML/SVG", () => {
    const html = "<html><head><style>@keyframes pulse{to{opacity:.5}}.dot{animation:pulse 2s infinite}</style></head><body><div class='dot'><svg viewBox='0 0 10 10'><circle cx='5' cy='5' r='3'/></svg></div></body></html>";
    expect(validateAnnouncementAnimation(Buffer.from(html))).toContain("@keyframes pulse");
    expect(validateAnnouncementAnimation(Buffer.from(html))).toContain('viewBox="0 0 10 10"');
  });
  it.each([
    "<script>fetch('/api/companies')</script>", "<div onclick='alert(1)'>Click</div>",
    "<a href='https://evil.test'>Navigate</a>", "<form action='/api/test'><input></form>",
    "<meta http-equiv='refresh' content='0;url=https://evil.test'>", "<base href='https://evil.test'>",
    "<iframe src='https://evil.test'></iframe>", "<img src='https://evil.test/pixel'>", "<link rel='stylesheet' href='https://evil.test'>",
    "<svg><foreignObject><p>Other namespace</p></foreignObject></svg>",
    "<svg><a xlink:href='https://evil.test'><text>Go</text></a></svg>",
    "<svg><animate attributeName='href' values='https://evil.test'/></svg>",
    "<object data='https://evil.test'></object>", "<button>Click</button>",
  ])("rejects active or resource-loading markup: %s", (html) => {
    expect(() => validateAnnouncementAnimation(Buffer.from(html))).toThrow();
  });
  it("rejects empty, oversized and invalid UTF-8 files", () => {
    for (const bytes of [Buffer.alloc(0), Buffer.alloc(128 * 1024 + 1), Buffer.from([0xff])]) {
      expect(() => validateAnnouncementAnimation(bytes)).toThrow();
    }
  });
});
