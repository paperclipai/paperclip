import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadChatMappings, findMappingForChat } from "../src/chat-mappings.js";
import type { ChatToCompanyMapping } from "../src/types.js";

const FIXTURE_DIR = join(tmpdir(), `bridge-chat-mappings-${Date.now()}`);

beforeAll(() => {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  // Personal workspace (uses legacy "karl" name alias)
  writeFileSync(
    join(FIXTURE_DIR, "karl.md"),
    `---
name: karl
telegram_chats:
  - "5395944622"
paperclip_company_id: "personal-uuid-1"
paperclip_default_agent_id: "karl-personal-uuid"
---
Body
`,
  );
  // Work workspace
  writeFileSync(
    join(FIXTURE_DIR, "work.md"),
    `---
name: work
telegram_chats:
  - "-5178581527"
paperclip_company_id: "work-uuid-1"
paperclip_default_agent_id: "karl-work-uuid"
paperclip_require_mention: true
---
Body
`,
  );
  // Finance workspace
  writeFileSync(
    join(FIXTURE_DIR, "finance.md"),
    `---
name: finance
telegram_chats:
  - "-5288875401"
paperclip_company_id: "finance-uuid-1"
---
Body
`,
  );
  // Workspace missing paperclip_company_id (P1A-4 hasn't run for it yet)
  writeFileSync(
    join(FIXTURE_DIR, "noted.md"),
    `---
name: noted
telegram_chats:
  - "-5160236986"
---
Body
`,
  );
  // Non-workspace markdown that shouldn't appear
  writeFileSync(join(FIXTURE_DIR, "README.md"), "Just docs\n");
});

afterAll(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

describe("loadChatMappings", () => {
  test("loads workspaces with full Paperclip metadata", async () => {
    const mappings = await loadChatMappings(FIXTURE_DIR);
    // karl + work + finance = 3 mapped (noted skipped — missing company_id)
    expect(mappings.length).toBe(3);

    const personal = mappings.find((m) => m.workspace === "personal");
    expect(personal).toBeDefined();
    expect(personal!.chatId).toBe("5395944622");
    expect(personal!.companyId).toBe("personal-uuid-1");
    expect(personal!.defaultAgent).toBe("__id__");
    expect(personal!.defaultAgentId).toBe("karl-personal-uuid");
  });

  test('vault legacy name "karl" normalizes to "personal"', async () => {
    const mappings = await loadChatMappings(FIXTURE_DIR);
    const fromKarl = mappings.find((m) => m.chatId === "5395944622");
    expect(fromKarl?.workspace).toBe("personal");
  });

  test("require_mention preserved from frontmatter", async () => {
    const mappings = await loadChatMappings(FIXTURE_DIR);
    const work = mappings.find((m) => m.workspace === "work");
    expect(work?.requireMention).toBe(true);
    const finance = mappings.find((m) => m.workspace === "finance");
    expect(finance?.requireMention).toBe(false);
  });

  test("skips workspaces missing paperclip_company_id", async () => {
    const mappings = await loadChatMappings(FIXTURE_DIR);
    expect(mappings.find((m) => m.workspace === "noted")).toBeUndefined();
  });

  test("ignores non-workspace markdown files", async () => {
    const mappings = await loadChatMappings(FIXTURE_DIR);
    expect(mappings.length).toBe(3); // not 4 — README.md ignored
  });
});

describe("findMappingForChat", () => {
  const mappings: ChatToCompanyMapping[] = [
    { chatId: "100", companyId: "c1", workspace: "personal", defaultAgent: "karl", requireMention: false },
    { chatId: "200", threadId: 5, companyId: "c2", workspace: "work", defaultAgent: "karl", requireMention: true },
    { chatId: "200", threadId: 7, companyId: "c3", workspace: "finance", defaultAgent: "karl", requireMention: false },
  ];

  test("matches plain chat", () => {
    const m = findMappingForChat(mappings, "100");
    expect(m?.workspace).toBe("personal");
  });

  test("matches chat + thread combination", () => {
    const m = findMappingForChat(mappings, "200", 5);
    expect(m?.workspace).toBe("work");
    const m2 = findMappingForChat(mappings, "200", 7);
    expect(m2?.workspace).toBe("finance");
  });

  test("falls back to chatId when threadId not provided", () => {
    const m = findMappingForChat(mappings, "200");
    expect(m).toBeDefined();
    // First matching chatId wins (work) when no thread specified
    expect(m?.workspace).toBe("work");
  });

  test("returns null on unknown chat", () => {
    expect(findMappingForChat(mappings, "999")).toBeNull();
  });
});
