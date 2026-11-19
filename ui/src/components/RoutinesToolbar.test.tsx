// @vitest-environment jsdom
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RoutinesToolbar } from "./RoutinesToolbar";
import { defaultRoutineView } from "@/lib/routine-list-view";

vi.mock("@/lib/router", () => ({ Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a> }));

describe("Routines filter rendering", () => {
  it("bounds selection reads for a large company filter menu", () => {
    const size = 1500;
    let reads = 0;
    const ids = Array.from({ length: size }, (_, i) => `project-${i}`);
    const selected = new Proxy(ids, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) {
          if (++reads > size * 2) throw new Error("Filter rendering repeatedly scanned its selected projects");
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const markup = renderToStaticMarkup(<RoutinesToolbar query="" onQueryChange={() => {}} sortField="title" sortDir="asc" groupBy="none" onSortChange={() => {}} onGroupChange={() => {}} onCreateRoutine={() => {}} filters={{ ...defaultRoutineView, projects: selected }} filterOptions={{ projects: ids.map(id => ({ id, name: id })) }} />);
    expect(markup).toContain("Filter routines (1500)");
    expect(reads).toBeGreaterThanOrEqual(size);
    expect(reads).toBeLessThanOrEqual(size * 2);
  });
});
