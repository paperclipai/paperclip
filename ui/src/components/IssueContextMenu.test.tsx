// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Issue } from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { IssueContextMenu } from "./IssueContextMenu";

vi.mock("../api/issues", () => ({ issuesApi: { update: vi.fn(), remove: vi.fn() } }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const issue = { id: "task-1", companyId: "company-1", identifier: "DEMO-1", title: "Review onboarding", status: "todo" } as Issue;
let root: Root;
let client: QueryClient;

async function click(element: Element | null) {
  expect(element).not.toBeNull();
  await act(async () => { element!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
}
function menuItem(label: string) {
  return [...document.querySelectorAll('[role="menuitem"]')].find(el => el.textContent?.includes(label)) ?? null;
}
function button(label: string) {
  return [...document.querySelectorAll('button')].find(el => el.textContent === label) ?? null;
}
async function openMenu(keyboard = false) {
  const row = document.querySelector('#row')!;
  await act(async () => {
    row.dispatchEvent(keyboard
      ? new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true })
      : new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
  });
}

beforeEach(async () => {
  vi.resetAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  document.body.innerHTML = '<div id="mount"></div>';
  root = createRoot(document.querySelector('#mount')!);
  await act(async () => { root.render(
    <QueryClientProvider client={client}>
      <IssueContextMenu issue={issue}><div id="row"><a href="/tasks/DEMO-1">Review onboarding</a></div></IssueContextMenu>
    </QueryClientProvider>,
  ); });
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); });

describe('IssueContextMenu', () => {
  it('CM-1 moves only the selected task and refreshes company collections', async () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    vi.mocked(issuesApi.update).mockResolvedValue({ ...issue, status: 'done', changes: {} });
    await openMenu();
    expect(menuItem('Todo')?.getAttribute('data-disabled')).not.toBeNull();
    await click(menuItem('Done'));
    expect(issuesApi.update).toHaveBeenCalledExactlyOnceWith('task-1', { status: 'done' });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['issues', 'company-1'] });
    expect(issuesApi.remove).not.toHaveBeenCalled();
  });

  it('CM-2 cancels deletion without a request, then deletes after confirmation', async () => {
    await openMenu();
    await click(menuItem('Delete task'));
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('DEMO-1: Review onboarding');
    expect(issuesApi.remove).not.toHaveBeenCalled();
    await click(button('Cancel'));
    expect(issuesApi.remove).not.toHaveBeenCalled();
    await openMenu();
    await click(menuItem('Delete task'));
    vi.mocked(issuesApi.remove).mockResolvedValue(issue);
    await click(button('Delete task'));
    expect(issuesApi.remove).toHaveBeenCalledExactlyOnceWith('task-1');
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it('CM-3 preserves confirmation and allows retry after a failed delete', async () => {
    vi.mocked(issuesApi.remove).mockRejectedValueOnce(new Error('Permission denied')).mockResolvedValueOnce(issue);
    await openMenu(); await click(menuItem('Delete task')); await click(button('Delete task'));
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Permission denied');
    await click(button('Delete task'));
    expect(issuesApi.remove).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it('CM-3 reports a failed move without deleting or invalidating data', async () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    vi.mocked(issuesApi.update).mockRejectedValue(new Error('Status change rejected'));
    await openMenu(); await click(menuItem('Done'));
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Status change rejected');
    expect(invalidate).not.toHaveBeenCalled();
    expect(issuesApi.remove).not.toHaveBeenCalled();
    await click(button('Close'));
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it('CM-4 opens with Shift+F10 and preserves the task link', async () => {
    await openMenu(true);
    expect(menuItem('Done')).not.toBeNull();
    expect(document.querySelector('#row a')?.getAttribute('href')).toBe('/tasks/DEMO-1');
    expect(issuesApi.update).not.toHaveBeenCalled();
  });

  it('CM-5 disables deletion while the request is pending', async () => {
    let resolve!: (issue: Issue) => void;
    vi.mocked(issuesApi.remove).mockReturnValue(new Promise(r => { resolve = r; }));
    await openMenu(); await click(menuItem('Delete task')); await click(button('Delete task'));
    expect(button('Deleting…')?.disabled).toBe(true);
    expect(button('Cancel')?.disabled).toBe(true);
    await click(button('Deleting…'));
    expect(issuesApi.remove).toHaveBeenCalledTimes(1);
    await act(async () => resolve(issue));
  });
});
