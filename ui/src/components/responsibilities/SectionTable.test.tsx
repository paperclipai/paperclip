// @vitest-environment jsdom
import { act, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { SectionTable, SectionTableFooterButton, SectionTableNote, SectionTableRow, TaskRefStat, WhoAvatar } from "./SectionTable";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
const agentsById = new Map([["agent-codex", { id: "agent-codex", name: "CodexCoder" } as Agent]]);
const table = () => host.querySelector<HTMLElement>('[data-section="routines"]')!;

async function render(element: ReactElement) {
  await act(async () => root.render(element));
}

function AddMenu({ onNew }: { onNew: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon-xs" variant="ghost" aria-label="Add a routine" data-section-add="">+</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={onNew}>New routine</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("SectionTable", () => {
  it("is one card: a header bar with the name and its +, then rows of title, one stat and who has it", async () => {
    await render(
      <SectionTable section="routines" title="Routines" add={<AddMenu onNew={() => {}} />}>
        <SectionTableRow
          to="/routines/weekly"
          rowData={{ "data-work-id": "routine-weekly" }}
          title="Weekly investor pipeline review"
          stat="Last successful run 8h ago"
          who={<WhoAvatar agentId="agent-codex" agentsById={agentsById} />}
        />
        <SectionTableRow to="/routines/crm" rowData={{ "data-work-id": "routine-crm" }} title="CRM sync" stat="Failed 2d ago" who={null} />
      </SectionTable>,
    );
    const card = table().querySelector<HTMLElement>("[data-section-table]")!;
    expect(card.getAttribute("data-slot")).toBe("card");
    const header = card.querySelector<HTMLElement>("[data-section-header]")!;
    // The header bar is the name and the + alone: no count, no collapse.
    expect(header.querySelector("h2")?.textContent).toBe("Routines");
    expect(header.textContent).toBe("Routines+");
    expect(table().getAttribute("aria-labelledby")).toBe(header.querySelector("h2")!.id);
    expect(header.querySelectorAll("button")).toHaveLength(1);

    const rows = [...card.querySelectorAll<HTMLElement>("[data-section-rows] > li")];
    expect(rows.map((row) => row.dataset.workId)).toEqual(["routine-weekly", "routine-crm"]);
    const first = rows[0]!.querySelector("a")!;
    expect(first.getAttribute("href")).toBe("/routines/weekly");
    expect(first.querySelector("[data-row-title]")?.textContent).toBe("Weekly investor pipeline review");
    // The full title is there on hover when it truncates.
    expect(first.querySelector("[data-row-title] [title]")?.getAttribute("title")).toBe("Weekly investor pipeline review");
    expect(first.querySelector("[data-row-stat]")?.textContent).toBe("Last successful run 8h ago");
    expect(first.querySelector('[data-row-who] [aria-label="CodexCoder"]')).not.toBeNull();
    // Rows hold three cells in the shared columns, even without someone to show.
    expect(rows[1]!.querySelector("a")!.children).toHaveLength(2);
    expect(rows[1]!.querySelector("[data-row-who]")).toBeNull();
    expect(card.querySelector("[data-section-rows]")?.className).toContain("sm:grid-cols-(--gtc-27)");
  });

  it("drops the who column when no row has anyone, and shows a task reference as one stat", async () => {
    await render(
      <SectionTable section="routines" title="Artifacts" withWho={false}>
        <SectionTableRow to="/issues/PAP-42#doc" title="November investor update" stat={<TaskRefStat identifier="PAP-42" when="1d ago" />} />
      </SectionTable>,
    );
    const row = table().querySelector("li a")!;
    expect(row.querySelector("[data-row-stat]")?.textContent).toBe("PAP-421d ago");
    expect(row.children).toHaveLength(1);
    expect(table().querySelector("[data-section-rows]")?.className).toContain("sm:grid-cols-(--gtc-13)");
  });

  it("empty: the header bar and one muted row of a few words", async () => {
    await render(<SectionTable section="routines" title="Routines" add={<AddMenu onNew={() => {}} />} empty="None yet." />);
    expect(table().querySelector("[data-section-header] h2")?.textContent).toBe("Routines");
    expect(table().querySelector("[data-section-empty]")?.textContent).toBe("None yet.");
    expect(table().querySelector("[data-section-rows]")).toBeNull();
  });

  it("the + still opens its menu", async () => {
    const onNew = vi.fn();
    await render(<SectionTable section="routines" title="Routines" add={<AddMenu onNew={onNew} />} empty="None yet." />);
    await act(async () => table().querySelector("[data-section-add]")!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 })));
    const item = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((entry) => entry.textContent === "New routine")!;
    expect(item).toBeDefined();
    await act(async () => item.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onNew).toHaveBeenCalledOnce();
  });

  it("quiet rows below the list: a button that changes what shows, and a note", async () => {
    const onClick = vi.fn();
    await render(
      <SectionTable
        section="routines"
        title="Tasks"
        empty="None open."
        footer={<><SectionTableFooterButton onClick={onClick}>Show 2 done</SectionTableFooterButton><SectionTableNote alert>Couldn’t start the run.</SectionTableNote></>}
      />,
    );
    const footer = table().querySelector<HTMLButtonElement>("[data-section-footer]")!;
    expect(footer.textContent).toBe("Show 2 done");
    await act(async () => footer.click());
    expect(onClick).toHaveBeenCalledOnce();
    expect(table().querySelector('[role="alert"]')?.textContent).toBe("Couldn’t start the run.");
  });
});
