import { useLayoutEffect, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queryKeys";
import { buildSkillMentionHref, type ChatExecutionDefaults } from "@paperclipai/shared";
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

export type FixtureState = "populated" | "empty" | "loading" | "error" | "long" | "many" | "setup" | "skills" | "guests" | "mentions" | "disconnected" | "repair-error" | "repair-checking";
function initialEndpoint(state: FixtureState) {
  if (state === "setup") return { ...endpoint, status: "draft" as const, setup: { github: { stage: "setup" as const } } };
  if (["disconnected", "repair-error", "repair-checking"].includes(state)) return {
    ...endpoint, status: "attention" as const,
    healthMessage: "GitHub connection needs attention",
    lastError: "GitHub failure has no request binding",
  };
  return structuredClone(endpoint);
}
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
    client.setQueryData(queryKeys.chatEndpoints.detail(endpoint.id), initialEndpoint(state));
    client.setQueryData(queryKeys.agents.detail(agent.id), agent);
    client.setQueryData(["github-setup", endpoint.id], initialEndpoint(state));
    client.setQueryData(["github-wizard", endpoint.id], { endpointId: endpoint.id, state: state === "setup" ? "create" : "connected" });
    client.setQueryData(queryKeys.chatEndpoints.list(endpoint.companyId), [endpoint]);
    client.setQueryData(queryKeys.projects.list(endpoint.companyId), []);
    client.setQueryData(["channel-workspace-choices", endpoint.companyId], []);
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
    let currentEndpoint = initialEndpoint(state);
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
      if (path === `/api/chat-endpoints/${endpoint.id}` && init?.method === "PATCH") {
        currentEndpoint = { ...currentEndpoint, ...body };
      }
      if (path === `/api/chat-endpoints/${endpoint.id}/setup` && init?.method === "POST") {
        if (body.action !== "reconnect") return Response.json({ error: "Unexpected setup action" }, { status: 400 });
        if (state === "repair-error") return Response.json({ error: "GitHub could not verify the saved private key. Check the App’s keys on GitHub." }, { status: 422 });
        if (state === "repair-checking") return new Promise<Response>(() => {});
        currentEndpoint = { ...currentEndpoint, status: "verifying", lastError: null, healthMessage: "Checking GitHub delivery", setup: { ...currentEndpoint.setup, step: "test" } };
        return Response.json(currentEndpoint);
      }
      if (path.endsWith("/github/setup")) {
        if (state === "setup") return Response.json({ endpointId: endpoint.id, state: "create" });
        if (currentEndpoint.status === "attention") return Response.json({ endpointId: endpoint.id, state: "recovery", message: "Reconnect the saved App to repair delivery." });
        currentEndpoint = { ...currentEndpoint, status: "active", healthMessage: "GitHub delivery verified", setup: { ...currentEndpoint.setup, step: "complete" } };
        return Response.json({ endpointId: endpoint.id, state: "connected" });
      }
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
          repos = repos.map((r) => {
            const change = body.resources?.find(
              (entry: { id: string; enabled?: boolean; executionDefaults?: ChatExecutionDefaults | null }) => entry.id === r.id,
            );
            return {
              ...r,
              enabled: change?.enabled ?? r.enabled,
              executionDefaults: change?.executionDefaults === undefined ? r.executionDefaults : change.executionDefaults,
            };
          });
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
      const reviewDetail = /^\/api\/chat-endpoints\/[^/]+\/github\/reviews\/([^/]+)$/.exec(path);
      if (reviewDetail) {
        const review = state === "empty" ? undefined : reviews.find((r) => r.id === decodeURIComponent(reviewDetail[1]));
        return review ? Response.json(review) : Response.json({ error: "Review not found" }, { status: 404 });
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
      return Response.json(currentEndpoint);
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
