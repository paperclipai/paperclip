import { useEffect, useRef, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  EXTERNAL_OBJECT_LIVENESS_STATES,
  EXTERNAL_OBJECT_STATUS_CATEGORIES,
  type ExternalObject,
  type ExternalObjectLivenessState,
  type ExternalObjectMention,
  type ExternalObjectStatusCategory,
  type ExternalObjectSummary,
} from "@paperclipai/shared";
import { ExternalObjectPill } from "@/components/ExternalObjectPill";
import { ExternalObjectStatusIcon } from "@/components/ExternalObjectStatusIcon";
import { ExternalObjectStatusSummary } from "@/components/ExternalObjectStatusSummary";
import { IssueFiltersPopover } from "@/components/IssueFiltersPopover";
import { IssueProperties } from "@/components/IssueProperties";
import { IssueRelatedWorkPanel } from "@/components/IssueRelatedWorkPanel";
import { IssueRow } from "@/components/IssueRow";
import { MarkdownBody, type MarkdownExternalReferenceMap } from "@/components/MarkdownBody";
import {
  countActiveIssueFilters,
  defaultIssueFilterState,
  type IssueFilterState,
} from "@/lib/issue-filters";
import {
  externalObjectCategoryLabel,
  externalObjectFallbackTone,
  externalObjectLivenessLabel,
  externalObjectProviderLabel,
  externalObjectTypeLabel,
} from "@/lib/external-objects";
import type { IssueExternalObjectGroup } from "@/hooks/useIssueExternalObjects";
import {
  storybookAgents,
  storybookExecutionWorkspaces,
  storybookIssueLabels,
  storybookIssues,
  storybookProjects,
} from "../fixtures/paperclipData";

function makeObject(args: {
  id: string;
  providerKey: string;
  objectType: string;
  statusCategory: ExternalObjectStatusCategory;
  liveness: ExternalObjectLivenessState;
  displayTitle?: string;
  url: string;
  statusLabel?: string;
}): ExternalObject {
  return {
    id: args.id,
    companyId: "company-1",
    providerKey: args.providerKey,
    pluginId: null,
    objectType: args.objectType,
    externalId: args.id,
    sanitizedCanonicalUrl: args.url,
    canonicalIdentityHash: args.id,
    displayTitle: args.displayTitle ?? null,
    statusKey: args.statusCategory,
    statusLabel: args.statusLabel ?? externalObjectCategoryLabel(args.statusCategory),
    statusCategory: args.statusCategory,
    statusTone: externalObjectFallbackTone(args.statusCategory),
    liveness: args.liveness,
    isTerminal: ["succeeded", "failed", "closed", "archived"].includes(args.statusCategory),
    data: {},
    remoteVersion: null,
    etag: null,
    lastResolvedAt: "2026-04-24T22:45:00.000Z",
    lastChangedAt: "2026-04-24T22:45:00.000Z",
    lastErrorAt: args.liveness === "unreachable" ? "2026-04-24T22:50:00.000Z" : null,
    nextRefreshAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    createdAt: "2026-04-24T20:00:00.000Z",
    updatedAt: "2026-04-24T22:45:00.000Z",
  };
}

function makeMention(args: {
  id: string;
  objectId: string;
  sourceKind: ExternalObjectMention["sourceKind"];
  documentKey?: string | null;
}): ExternalObjectMention {
  return {
    id: args.id,
    companyId: "company-1",
    sourceIssueId: "issue-1",
    sourceKind: args.sourceKind,
    sourceRecordId: null,
    documentKey: args.documentKey ?? null,
    propertyKey: null,
    matchedTextRedacted: null,
    sanitizedDisplayUrl: "https://example.com/object",
    canonicalIdentityHash: args.objectId,
    canonicalIdentity: null,
    objectId: args.objectId,
    providerKey: null,
    detectorKey: null,
    objectType: null,
    confidence: "exact",
    createdByPluginId: null,
    createdAt: "2026-04-24T20:00:00.000Z",
    updatedAt: "2026-04-24T22:45:00.000Z",
  };
}

function makeGroup(args: {
  object: ExternalObject;
  mentionCount?: number;
  sourceLabels?: string[];
}): IssueExternalObjectGroup {
  return {
    group: {
      object: args.object,
      mentions: [makeMention({ id: `${args.object.id}-m`, objectId: args.object.id, sourceKind: "description" })],
      mentionCount: args.mentionCount ?? 1,
      sourceLabels: args.sourceLabels ?? ["description"],
    },
    pill: {
      providerKey: args.object.providerKey,
      objectType: args.object.objectType,
      statusCategory: args.object.statusCategory,
      liveness: args.object.liveness,
      displayTitle: args.object.displayTitle,
      statusLabel: args.object.statusLabel,
      url: args.object.sanitizedCanonicalUrl,
    },
    mentionCount: args.mentionCount ?? 1,
    sourceLabels: args.sourceLabels ?? ["description"],
  };
}

function StateMatrix() {
  return (
    <div className="paperclip-story space-y-8">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">External object status matrix</h1>
        <p className="text-sm text-muted-foreground">
          Every status category × liveness combination from the UX spec §6, used as the canonical
          presentational reference for inline markdown, pills, properties, and rollups.
        </p>
      </header>
      <table className="w-full table-auto border-collapse text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th className="px-3 py-2">Category</th>
            {EXTERNAL_OBJECT_LIVENESS_STATES.map((liveness) => (
              <th key={liveness} className="px-3 py-2">{externalObjectLivenessLabel(liveness)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {EXTERNAL_OBJECT_STATUS_CATEGORIES.map((category) => (
            <tr key={category} className="border-b border-border">
              <td className="px-3 py-3 font-mono text-xs text-muted-foreground">{category}</td>
              {EXTERNAL_OBJECT_LIVENESS_STATES.map((liveness) => (
                <td key={liveness} className="px-3 py-3">
                  <ExternalObjectStatusIcon
                    category={category}
                    liveness={liveness}
                    sizeClassName="h-5 w-5"
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Pills (host-rendered identity, no plugin React)</h2>
        <div className="flex flex-wrap items-center gap-2">
          <ExternalObjectPill
            object={{
              providerKey: "github",
              objectType: "pull_request",
              statusCategory: "succeeded",
              liveness: "fresh",
              displayTitle: "Add external refs",
              url: "https://github.com/acme/web/pull/241",
            }}
            sourceCount={4}
            sourceSummary="description, 3 comments"
          />
          <ExternalObjectPill
            object={{
              providerKey: "github",
              objectType: "pull_request",
              statusCategory: "failed",
              liveness: "stale",
              displayTitle: "Bad CI run",
              url: "https://github.com/acme/web/pull/242",
            }}
            sourceCount={2}
          />
          <ExternalObjectPill
            object={{
              providerKey: "hubspot",
              objectType: "lead",
              statusCategory: "auth_required",
              liveness: "auth_required",
              displayTitle: "Acme deal",
              url: "https://app.hubspot.com/leads/99",
            }}
          />
          <ExternalObjectPill
            object={{
              providerKey: "linear",
              objectType: "issue",
              statusCategory: "running",
              liveness: "fresh",
              displayTitle: "Spike: queues",
              url: "https://linear.app/acme/issue/INF-44",
            }}
          />
          <ExternalObjectPill
            object={{
              providerKey: "ci",
              objectType: "deployment",
              statusCategory: "unreachable",
              liveness: "unreachable",
              displayTitle: "deploy prod-0412",
              url: "https://ci.example.com/runs/88421",
            }}
          />
        </div>
      </section>
    </div>
  );
}

function inlineMarkdownStory() {
  const references: MarkdownExternalReferenceMap = {
    "https://github.com/acme/web/pull/241": {
      providerKey: "github",
      objectType: "pull_request",
      statusCategory: "succeeded",
      liveness: "fresh",
      statusLabel: "Merged",
      displayTitle: "Add external refs",
    },
    "https://github.com/acme/web/pull/242": {
      providerKey: "github",
      objectType: "pull_request",
      statusCategory: "failed",
      liveness: "stale",
      statusLabel: "CI failed",
      displayTitle: "Flaky tests",
    },
    "https://github.com/acme/web/pull/243": {
      providerKey: "github",
      objectType: "pull_request",
      statusCategory: "waiting",
      liveness: "fresh",
      statusLabel: "Awaiting review",
      displayTitle: "Add liveness overlay",
    },
    "https://app.hubspot.com/leads/99": {
      providerKey: "hubspot",
      objectType: "lead",
      statusCategory: "auth_required",
      liveness: "auth_required",
      statusLabel: "Reconnect",
      displayTitle: "Acme deal",
    },
    "https://ci.example.com/runs/88421": {
      providerKey: "ci",
      objectType: "deployment",
      statusCategory: "unreachable",
      liveness: "unreachable",
      statusLabel: "Unreachable",
      displayTitle: "Prod-0412",
    },
  };
  const markdown = `Status of recent integrations:\n\n- Merged PR: https://github.com/acme/web/pull/241\n- Stale failed CI: https://github.com/acme/web/pull/242\n- Awaiting review: https://github.com/acme/web/pull/243\n- Auth required: https://app.hubspot.com/leads/99\n- Unreachable deploy: https://ci.example.com/runs/88421\n- Unrelated control link: https://random.example.com/path\n\n\`\`\`\n# Code blocks must be left alone — https://github.com/acme/web/pull/241\n\`\`\`\n\nInline code stays plain too: \`https://github.com/acme/web/pull/241\`.`;
  return (
    <div className="paperclip-story space-y-4 text-sm">
      <h2 className="text-lg font-medium">Inline markdown decoration</h2>
      <MarkdownBody externalReferences={references}>{markdown}</MarkdownBody>
    </div>
  );
}

function relatedWorkStory() {
  const externalObjects = [
    makeGroup({
      object: makeObject({
        id: "obj-1",
        providerKey: "github",
        objectType: "pull_request",
        statusCategory: "failed",
        liveness: "fresh",
        displayTitle: "Add external refs",
        url: "https://github.com/acme/web/pull/241",
      }),
      mentionCount: 4,
      sourceLabels: ["description", "comments", "plan document"],
    }),
    makeGroup({
      object: makeObject({
        id: "obj-2",
        providerKey: "hubspot",
        objectType: "lead",
        statusCategory: "auth_required",
        liveness: "auth_required",
        displayTitle: "Acme deal",
        url: "https://app.hubspot.com/leads/99",
      }),
      mentionCount: 1,
      sourceLabels: ["External links property"],
    }),
    makeGroup({
      object: makeObject({
        id: "obj-3",
        providerKey: "ci",
        objectType: "deployment",
        statusCategory: "running",
        liveness: "fresh",
        displayTitle: "deploy prod-0412",
        url: "https://ci.example.com/runs/88421",
      }),
      mentionCount: 2,
      sourceLabels: ["comments"],
    }),
    makeGroup({
      object: makeObject({
        id: "obj-4",
        providerKey: "github",
        objectType: "issue",
        statusCategory: "succeeded",
        liveness: "stale",
        displayTitle: "Closed parent issue",
        url: "https://github.com/acme/web/issues/15",
      }),
      mentionCount: 1,
      sourceLabels: ["comments"],
    }),
  ];

  return (
    <IssueRelatedWorkPanel
      relatedWork={{
        outbound: [],
        inbound: [],
      }}
      externalObjects={externalObjects}
    />
  );
}

function projectsRollupStory() {
  function summary(args: {
    failed?: number;
    waiting?: number;
    running?: number;
    succeeded?: number;
    auth?: number;
    stale?: number;
  }): ExternalObjectSummary {
    const objects: ExternalObjectSummary["objects"] = [];
    function pushMany(category: ExternalObjectStatusCategory, count: number) {
      for (let i = 0; i < count; i += 1) {
        objects.push({
          id: `obj-${category}-${i}`,
          providerKey: "github",
          objectType: "pull_request",
          displayTitle: null,
          statusCategory: category,
          statusTone: externalObjectFallbackTone(category),
          liveness: args.stale && i % 2 === 0 ? "stale" : "fresh",
          isTerminal: false,
        });
      }
    }
    pushMany("failed", args.failed ?? 0);
    pushMany("waiting", args.waiting ?? 0);
    pushMany("running", args.running ?? 0);
    pushMany("succeeded", args.succeeded ?? 0);
    pushMany("auth_required", args.auth ?? 0);
    const tones = objects.map((o) => o.statusTone);
    const dominant: ExternalObjectSummary["highestSeverity"] =
      tones.includes("danger") ? "danger"
        : tones.includes("warning") ? "warning"
        : tones.includes("info") ? "info"
        : tones.includes("success") ? "success"
        : "muted";
    const byStatusCategory: Record<string, number> = {};
    for (const obj of objects) {
      byStatusCategory[obj.statusCategory] = (byStatusCategory[obj.statusCategory] ?? 0) + 1;
    }
    return {
      total: objects.length,
      byStatusCategory,
      byLiveness: { fresh: objects.length, stale: 0, auth_required: 0, unreachable: 0, unknown: 0 },
      highestSeverity: dominant,
      staleCount: args.stale ?? 0,
      authRequiredCount: args.auth ?? 0,
      unreachableCount: 0,
      objects,
    };
  }

  const projects = [
    { name: "Paperclip App", color: "#6366f1", summary: summary({ failed: 3, running: 12 }) },
    { name: "Marketing site", color: "#22c55e", summary: summary({ waiting: 2 }) },
    { name: "Experimental", color: "#a855f7", summary: summary({ succeeded: 6 }) },
    { name: "Auth provider", color: "#f97316", summary: summary({ auth: 1 }) },
  ];
  return (
    <div className="paperclip-story w-72 rounded border border-border bg-background p-2">
      <div className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">Projects (sidebar)</div>
      <ul className="flex flex-col">
        {projects.map((project) => (
          <li
            key={project.name}
            className="flex items-center gap-2.5 px-3 py-1.5 text-[13px] font-medium hover:bg-accent/50"
          >
            <span className="h-3.5 w-3.5 shrink-0 rounded-sm" style={{ backgroundColor: project.color }} />
            <span className="flex-1 truncate">{project.name}</span>
            <ExternalObjectStatusSummary summary={project.summary} compact />
          </li>
        ))}
      </ul>
    </div>
  );
}

function StateMatrixStory() {
  return (
    <div className="paperclip-story space-y-12 p-6">
      <StateMatrix />
      {inlineMarkdownStory()}
      {relatedWorkStory()}
      {projectsRollupStory()}
    </div>
  );
}

function makeIntegrationGroups(): IssueExternalObjectGroup[] {
  return [
    makeGroup({
      object: makeObject({
        id: "obj-int-failed",
        providerKey: "github",
        objectType: "pull_request",
        statusCategory: "failed",
        liveness: "fresh",
        displayTitle: "CI broken on main",
        url: "https://github.com/acme/web/pull/241",
        statusLabel: "CI failed",
      }),
      mentionCount: 4,
      sourceLabels: ["Description", "3 comments"],
    }),
    makeGroup({
      object: makeObject({
        id: "obj-int-auth",
        providerKey: "hubspot",
        objectType: "lead",
        statusCategory: "auth_required",
        liveness: "auth_required",
        displayTitle: "Acme deal — needs reconnect",
        url: "https://app.hubspot.com/leads/99",
        statusLabel: "Reconnect",
      }),
      mentionCount: 1,
      sourceLabels: ["External links property"],
    }),
    makeGroup({
      object: makeObject({
        id: "obj-int-running",
        providerKey: "ci",
        objectType: "deployment",
        statusCategory: "running",
        liveness: "fresh",
        displayTitle: "deploy prod-0412",
        url: "https://ci.example.com/runs/88421",
        statusLabel: "Running",
      }),
      mentionCount: 2,
      sourceLabels: ["2 comments"],
    }),
  ];
}

function makeIntegrationSummary(): ExternalObjectSummary {
  const objects = makeIntegrationGroups()
    .map((entry) => entry.group.object)
    .filter((object): object is ExternalObject => Boolean(object))
    .map((object) => ({
      id: object.id,
      providerKey: object.providerKey,
      objectType: object.objectType,
      displayTitle: object.displayTitle,
      statusCategory: object.statusCategory,
      statusTone: object.statusTone,
      liveness: object.liveness,
      isTerminal: object.isTerminal,
    }));
  const tones = objects.map((o) => o.statusTone);
  const dominant: ExternalObjectSummary["highestSeverity"] =
    tones.includes("danger") ? "danger"
      : tones.includes("warning") ? "warning"
      : tones.includes("info") ? "info"
      : tones.includes("success") ? "success"
      : "muted";
  const byStatusCategory: Record<string, number> = {};
  for (const o of objects) {
    byStatusCategory[o.statusCategory] = (byStatusCategory[o.statusCategory] ?? 0) + 1;
  }
  return {
    total: objects.length,
    byStatusCategory,
    byLiveness: { fresh: objects.length - 1, stale: 0, auth_required: 1, unreachable: 0, unknown: 0 },
    highestSeverity: dominant,
    staleCount: 0,
    authRequiredCount: 1,
    unreachableCount: 0,
    objects,
  };
}

function PropertiesPanelDesktop() {
  const issue = storybookIssues[0]!;
  return (
    <div className="paperclip-story w-[420px] rounded-lg border border-border bg-background/70 p-4">
      <div className="mb-3 text-xs uppercase tracking-wide text-muted-foreground">
        Issue properties — desktop @ 1440×900
      </div>
      <IssueProperties
        issue={issue}
        childIssues={[]}
        externalObjects={makeIntegrationGroups()}
        onAddSubIssue={() => undefined}
        onUpdate={() => undefined}
      />
    </div>
  );
}

function PropertiesPanelMobile() {
  const issue = storybookIssues[0]!;
  return (
    <div className="paperclip-story mx-auto w-[358px] rounded-lg border border-border bg-background/70 p-3">
      <div className="mb-3 text-xs uppercase tracking-wide text-muted-foreground">
        Issue properties — mobile sheet @ 390×844
      </div>
      <IssueProperties
        issue={issue}
        childIssues={[]}
        externalObjects={makeIntegrationGroups()}
        onAddSubIssue={() => undefined}
        onUpdate={() => undefined}
        inline
      />
    </div>
  );
}

function RelatedWorkEmptyDesktop() {
  return (
    <div className="paperclip-story space-y-3 p-6">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        Related work — empty external objects (zero refs, empty copy visible)
      </div>
      <IssueRelatedWorkPanel
        relatedWork={{ outbound: [], inbound: [] }}
        externalObjects={[]}
      />
    </div>
  );
}

function SidebarMobileDrawer() {
  const summary = makeIntegrationSummary();
  return (
    <div className="paperclip-story mx-auto w-[320px] rounded border border-border bg-background p-2">
      <div className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">Projects (mobile drawer)</div>
      <ul className="flex flex-col">
        {[
          { name: "Paperclip App", color: "#6366f1", summary },
          { name: "Marketing site", color: "#22c55e", summary: { ...summary, highestSeverity: "warning", byStatusCategory: { waiting: 2 }, total: 2, objects: [] } },
          { name: "Experimental", color: "#a855f7", summary: { ...summary, highestSeverity: "muted", byStatusCategory: {}, total: 0, objects: [] } },
        ].map((project) => (
          <li
            key={project.name}
            className="flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium hover:bg-accent/50"
          >
            <span className="h-3.5 w-3.5 shrink-0 rounded-sm" style={{ backgroundColor: project.color }} />
            <span className="flex-1 truncate">{project.name}</span>
            <ExternalObjectStatusSummary summary={project.summary as ExternalObjectSummary} compact />
          </li>
        ))}
      </ul>
    </div>
  );
}

function IssueListWithBadge() {
  const summary = makeIntegrationSummary();
  return (
    <div className="paperclip-story p-6">
      <div className="mb-3 text-xs uppercase tracking-wide text-muted-foreground">
        Issue list — desktop @ 1440×900 (badge + control row)
      </div>
      <div className="overflow-hidden rounded-xl border border-border bg-background/70">
        {storybookIssues.slice(0, 2).map((issue, index) => (
          <IssueRow
            key={issue.id}
            issue={issue}
            externalObjectSummary={index === 0 ? summary : null}
            desktopTrailing={
              <span className="text-xs text-muted-foreground">{issue.priority}</span>
            }
          />
        ))}
      </div>
    </div>
  );
}

function FilterPopoverWithExternalChecked() {
  const [state, setState] = useState<IssueFilterState>({
    ...defaultIssueFilterState,
    externalObjectStatuses: ["failed", "auth_required"],
  });
  const triggerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      triggerRef.current?.querySelector("button")?.click();
    }, 150);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div className="paperclip-story flex min-h-[640px] items-start justify-end p-6">
      <div ref={triggerRef}>
        <IssueFiltersPopover
          state={state}
          onChange={(patch) => setState((current) => ({ ...current, ...patch }))}
          activeFilterCount={countActiveIssueFilters(state, true)}
          agents={storybookAgents.map((agent) => ({ id: agent.id, name: agent.name }))}
          projects={storybookProjects.map((project) => ({ id: project.id, name: project.name }))}
          labels={storybookIssueLabels.map((label) => ({ id: label.id, name: label.name, color: label.color }))}
          currentUserId="user-board"
          enableRoutineVisibilityFilter
          buttonVariant="outline"
          workspaces={storybookExecutionWorkspaces.map((workspace) => ({ id: workspace.id, name: workspace.name }))}
          creators={[
            { id: "user:user-board", label: "Riley Board", kind: "user", searchText: "board user human" },
          ]}
        />
      </div>
    </div>
  );
}

function IntegrationSurfacesStory() {
  return (
    <div className="paperclip-story space-y-10 p-6">
      <PropertiesPanelDesktop />
      <PropertiesPanelMobile />
      <RelatedWorkEmptyDesktop />
      <SidebarMobileDrawer />
      <IssueListWithBadge />
      <FilterPopoverWithExternalChecked />
    </div>
  );
}

const meta = {
  title: "Foundations/External Objects",
  component: StateMatrixStory,
  parameters: {
    docs: {
      description: {
        component:
          "External-object surface gallery: the §6 state matrix, the inline markdown decoration, the related-work section, and the project-rollup sidebar marker. Mirrors the Phase 6 acceptance set from the UX spec.",
      },
    },
  },
} satisfies Meta<typeof StateMatrixStory>;

export default meta;

type Story = StoryObj<typeof meta>;

export const FullSurface: Story = {};

export const PropertiesRowDesktop: StoryObj = {
  render: () => <PropertiesPanelDesktop />,
};

export const PropertiesRowMobileSheet: StoryObj = {
  render: () => <PropertiesPanelMobile />,
};

export const RelatedWorkEmpty: StoryObj = {
  render: () => <RelatedWorkEmptyDesktop />,
};

export const SidebarMobile: StoryObj = {
  render: () => <SidebarMobileDrawer />,
};

export const IssueListRow: StoryObj = {
  render: () => <IssueListWithBadge />,
};

export const FilterPopoverOpen: StoryObj = {
  render: () => <FilterPopoverWithExternalChecked />,
};

export const IntegrationSurfaces: StoryObj = {
  render: () => <IntegrationSurfacesStory />,
};
