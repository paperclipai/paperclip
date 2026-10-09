import { useLayoutEffect, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queryKeys";
import { buildSkillMentionHref } from "@paperclipai/shared";
import { EditorAutocompleteProvider } from "@/context/EditorAutocompleteContext";
import {
  endpoint,
  agent,
  configuration,
  resources,
  reviews,
  conversations,
  links,
  members,
} from "./fixtures";

export type FixtureState = "populated" | "empty" | "loading" | "error" | "long" | "many" | "setup" | "skills" | "guests" | "mentions";
const reviewSkill = {
  id: "11111111-1111-4111-8111-111111111111", slug: "code-review", name: "Code review",
  key: "company/company-storybook/code-review", description: "Follow the team's review playbook.",
};
/** Only fixture IDs are intercepted. All shell requests use Storybook's shared API fixtures. */
export function FixtureApi({
  state = "populated",
  children,
}: {
  state?: FixtureState;
  children: ReactNode;
}) {
  const [client] = useState(() => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    client.setQueryData(queryKeys.chatEndpoints.detail(endpoint.id), endpoint);
    client.setQueryData(queryKeys.agents.detail(agent.id), agent);
    client.setQueryData(["github-setup", endpoint.id], state === "setup"
      ? { ...endpoint, status: "draft", setup: { github: { stage: "setup" } } } : endpoint);
    client.setQueryData(["github-wizard", endpoint.id], { endpointId: endpoint.id, state: state === "setup" ? "create" : "connected" });
    client.setQueryData(queryKeys.chatEndpoints.list(endpoint.companyId), [endpoint]);
    client.setQueryData(["project-repositories", endpoint.companyId], {
      repositories: [
        { id: "100", fullName: "acme/web", ownerType: "organization", url: "https://github.com/acme/web", connections: ["GitHub"] },
        { id: "101", fullName: "paperclipai/api", ownerType: "organization", url: "https://github.com/paperclipai/api", connections: ["GitHub"] },
        { id: "102", fullName: "mayacoder/site", ownerType: "personal", url: "https://github.com/mayacoder/site", connections: ["GitHub"] },
      ], connectionCount: 1, failedConnectionCount: 0,
    });
    client.setQueryData(["github-members", endpoint.companyId], members);
    client.setQueryData(queryKeys.companySkills.list(endpoint.companyId), [reviewSkill]);
    return client;
  });
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    const original = window.fetch;
    let saved = { revision: 2, configuration: structuredClone(configuration) };
    if (state === "skills") saved.configuration.defaults = {
      ...saved.configuration.defaults,
      instructions: `Use [/code-review](${buildSkillMentionHref(reviewSkill.id, reviewSkill.slug)}) when reviewing pull requests.`,
      invocation: "linked_authors",
    };
    if (state === "guests") saved.configuration.people.push({ kind: "guest", githubUserId: "99", login: "community-contributor", sponsorUserId: "user-board", permissionProfile: "restricted", automaticReviews: true });
    if (state === "mentions") { saved.configuration.memberAccess = "all_linked"; saved.configuration.defaults.invocation = "mentions_only"; }
    let repos = structuredClone(resources);
    if (state === "many") repos = Array.from({ length: 1000 }, (_, index) => ({
      ...repos[0], id: `repository-${index}`, providerResourceId: `acme/repository-${String(index).padStart(4, "0")}`,
      label: `acme/repository-${String(index).padStart(4, "0")}`, enabled: true,
    }));
    let identities = structuredClone(links);
    const failedPaths = new Set<string>();
    window.fetch = async (input, init) => {
      const raw =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const url = new URL(raw, window.location.origin);
      const path = url.pathname;
      if (!path.includes(`/chat-endpoints/${endpoint.id}`))
        return original(input, init);
      if (state === "loading") return new Promise<Response>(() => {});
      if (
        state === "error" &&
        (path.endsWith("/configuration") || path.endsWith("/resources") || path.endsWith("/github/repositories")) &&
        !failedPaths.has(path)
      ) {
        failedPaths.add(path);
        return Response.json(
          { error: "Could not reach GitHub. Try again." },
          { status: 503 },
        );
      }
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (path.endsWith("/github/setup")) return Response.json({ endpointId: endpoint.id, state: state === "setup" ? "create" : "connected" });
      if (path.endsWith("/repositories/access")) {
        repos = repos.map((r) => (!body.enabled || r.availability === "available") ? { ...r, enabled: body.enabled } : r);
        return Response.json({ success: true });
      }
      if (path.endsWith("/github/repositories")) {
        const offset = Number(url.searchParams.get("offset") ?? 0);
        const limit = Number(url.searchParams.get("limit") ?? 20);
        const search = (url.searchParams.get("search") ?? "").toLowerCase();
        const all = state === "empty" ? [] : state === "long" ? repos.map((r) => ({ ...r,
          label: `acme/platform-services-production-web-${r.id}-accessibility-improvements` })) : repos;
        const filtered = all.filter((r) => r.label.toLowerCase().includes(search));
        return Response.json({ items: filtered.slice(offset, offset + limit),
          nextOffset: offset + limit < filtered.length ? offset + limit : null,
          totalCount: all.length, enabledCount: all.filter((r) => r.enabled).length,
          availableCount: all.filter((r) => r.availability === "available").length });
      }
      if (path.endsWith("/configuration")) {
        if (init?.method === "PUT")
          saved = {
            revision: saved.revision + 1,
            configuration: body.configuration,
          };
        return Response.json(saved);
      }
      if (path.endsWith("/repositories/refresh")) return Response.json(repos);
      if (path.endsWith("/resources")) {
        if (init?.method === "PUT")
          repos = repos.map((r) => ({
            ...r,
            enabled:
              body.resources?.find(
                (change: { id: string; enabled: boolean }) =>
                  change.id === r.id,
              )?.enabled ?? r.enabled,
          }));
        const rows =
          state === "empty"
            ? []
            : state === "long"
              ? repos.map((r) => ({
                  ...r,
                  label: `acme/platform-services-production-web-${r.id}-accessibility-improvements`,
                }))
              : repos;
        return Response.json({ items: rows });
      }
      if (path.endsWith("/reviews"))
        return Response.json(state === "empty" ? [] : reviews);
      if (path.endsWith("/activity"))
        return Response.json({ items: [], nextCursor: null });
      if (path.endsWith("/conversations"))
        return Response.json({
          items:
            state === "empty"
              ? []
              : state === "long"
                ? conversations.map((r) => ({
                    ...r,
                    issueTitle: `${r.issueTitle} for every keyboard, screen reader, and narrow screen entry point`,
                  }))
                : conversations,
        });
      if (path.endsWith("/principals"))
        return Response.json({ items: state === "empty" ? [] : identities });
      if (path.endsWith("/link") && init?.method === "DELETE") {
        identities = identities.filter(
          (link) => !path.includes(link.principalId),
        );
        return Response.json({ success: true });
      }
      if (path.endsWith("/people/lookup"))
        return Response.json({ githubUserId: "44", login: body.login });
      return Response.json(state === "setup" ? { ...endpoint, status: "draft", setup: { github: { stage: "setup" } } } : endpoint);
    };
    setReady(true);
    return () => {
      window.fetch = original;
      client.clear();
    };
  }, [client, state]);
  return ready ? (
    <QueryClientProvider client={client}>
      <EditorAutocompleteProvider>{children}</EditorAutocompleteProvider>
    </QueryClientProvider>
  ) : null;
}
