export interface SearchTask {
  id: string;
  identifier: string;
  companyId: string;
  title: string;
  description: string;
  status: string;
  assigneeUserId: string;
  assigneeAgentId: null;
}

function exactIds(actual: readonly string[], expected: readonly string[]) {
  return actual.length === expected.length && new Set(actual).size === actual.length
    && expected.every(id => actual.includes(id));
}

/** Saved records and observed UI identities must agree; missing evidence fails. */
export function taskSearchEvidencePasses(input: {
  expected: readonly SearchTask[];
  saved: readonly (SearchTask | null)[];
  runs: readonly (readonly unknown[] | null)[];
  searchIds: readonly string[];
  filteredIds: readonly string[];
  reloadedIds: readonly string[];
  returnedIds: readonly string[];
  reloadedQuery: string;
  returnedQuery: string;
  marker: string;
  reloadedStatusSelected: boolean;
  returnedStatusSelected: boolean;
  openedIdentifier: string | null;
  reopenedIdentifier: string | null;
  titleVisible: boolean;
  descriptionVisible: boolean;
}) {
  const [target, statusControl, searchControl] = input.expected;
  const validFixture = input.expected.length === 3 && Boolean(target?.id && target.identifier && target.companyId
    && target.assigneeUserId && input.marker) && new Set(input.expected.map(task => task.id)).size === 3
    && new Set(input.expected.map(task => task.identifier)).size === 3
    && input.expected.every(task => task.companyId === target!.companyId && task.assigneeUserId === target!.assigneeUserId
      && task.assigneeAgentId === null && task.description.length > 0)
    && target!.status === "backlog" && statusControl?.status === "done" && searchControl?.status === "backlog"
    && target!.title.includes(input.marker) && statusControl!.title.includes(input.marker)
    && !`${searchControl!.title} ${searchControl!.description}`.includes(input.marker);
  const persisted = validFixture && input.saved.length === 3 && input.expected.every((expected, index) => {
    const saved = input.saved[index];
    return saved !== null && saved !== undefined && Object.keys(expected).every(key =>
      saved[key as keyof SearchTask] === expected[key as keyof SearchTask]);
  });
  return {
    search: validFixture && exactIds(input.searchIds, [target!.id, statusControl!.id]),
    filter: validFixture && exactIds(input.filteredIds, [target!.id]),
    persistence: validFixture && input.reloadedQuery === input.marker && input.returnedQuery === input.marker
      && input.reloadedStatusSelected && input.returnedStatusSelected
      && exactIds(input.reloadedIds, [target!.id]) && exactIds(input.returnedIds, [target!.id]),
    reopen: persisted && input.openedIdentifier === target!.identifier && input.reopenedIdentifier === target!.identifier
      && input.titleVisible && input.descriptionVisible,
    noAgentWork: persisted && input.runs.length === 3 && input.runs.every(runs => Array.isArray(runs) && runs.length === 0),
  };
}
