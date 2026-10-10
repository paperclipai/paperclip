/** Review fixtures only. These are not an API contract or an authorization implementation. */
export interface Repository {
  id: string;
  fullName: string;
  url: string;
  private: boolean;
  connections: string[];
}

interface Connection {
  id: string;
  label: string;
  usable: boolean;
  repos: Omit<Repository, "connections">[];
}

const repo = (id: string, fullName: string, isPrivate = true) => ({
  id, fullName, url: `https://github.com/${fullName}`, private: isPrivate,
});

export const connections: Connection[] = [
  {
    id: "personal", label: "Your GitHub · dotta", usable: true,
    repos: [repo("101", "dotta/papercool"), repo("102", "dotta/experiments"), repo("201", "papercool/web")],
  },
  {
    id: "company", label: "Company GitHub · connected by Sam", usable: true,
    repos: [repo("201", "papercool/web"), repo("202", "papercool/api"), repo("203", "papercool/docs", false),
      ...["design-system", "mobile", "infrastructure", "integrations", "cli", "analytics", "templates", "status", "website", "sdk"].map((name, i) => repo(String(300 + i), `papercool/${name}`)),
      ...Array.from({ length: 48 }, (_, i) => repo(String(400 + i), `papercool/service-${String(i + 1).padStart(2, "0")}`))],
  },
  { id: "other-personal", label: "Sam’s private GitHub", usable: false, repos: [repo("900", "sam/private-project")] },
];

// Provider IDs keep one repository stable across connections and name changes.
export function availableRepositories(personalOnly = false): Repository[] {
  const byId = new Map<string, Repository>();
  for (const connection of connections.filter((c) => c.usable && (!personalOnly || c.id === "personal"))) {
    for (const item of connection.repos) {
      const existing = byId.get(item.id);
      if (existing) existing.connections.push(connection.label);
      else byId.set(item.id, { ...item, connections: [connection.label] });
    }
  }
  return [...byId.values()].sort((a, b) => a.fullName.localeCompare(b.fullName));
}

export type RepositoryState = "ready" | "disconnected" | "loading" | "error" | "empty";

export const crowdedRepoIds = availableRepositories().slice(0, 40).map((repo) => repo.id);

export const reviewViewports = {
  short: { name: "Short desktop", styles: { width: "1024px", height: "480px" } },
  mobileShort: { name: "Short mobile / keyboard-sized", styles: { width: "390px", height: "420px" } },
};
