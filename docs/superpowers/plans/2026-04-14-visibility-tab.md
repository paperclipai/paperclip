# Visibility Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Visibility tab to the Paperclip UI showing a real-time grid of file cards grouped by agent, displaying rolling diffs as agents edit files during active runs.

**Architecture:** File-edit events flow through the existing `heartbeat.run.event` pipeline. Adapters POST events to a new server endpoint, which stores them in the `heartbeatRunEvents` table and pushes them via WebSocket. The UI filters for `eventType === "file.edit"` events, accumulates them into a `Map<runId, Map<filePath, event[]>>`, and renders them as file cards grouped by agent rows.

**Tech Stack:** TypeScript (server + UI), React, TanStack Query, shadcn/ui, Express, Drizzle ORM, WebSocket. Python for Vibe Stack adapter instrumentation.

---

## File Map

### Paperclip — Shared Types
- **Modify:** `packages/shared/src/types/heartbeat.ts` — add `FileEditEventData` interface
- **Modify:** `packages/shared/src/types/index.ts` — re-export new type

### Paperclip — Server
- **Modify:** `server/src/services/heartbeat.ts` — add `appendExternalRunEvent()` + `listFileEventsForActiveRuns()` to the returned service object
- **Modify:** `server/src/routes/agents.ts` — add POST run-event endpoint + GET active file-events endpoint

### Paperclip — UI
- **Create:** `ui/src/pages/Visibility.tsx` — main page component
- **Create:** `ui/src/components/AgentFileRow.tsx` — agent header + horizontal file card scroll
- **Create:** `ui/src/components/FileCard.tsx` — individual file card with rolling diff
- **Create:** `ui/src/components/DiffView.tsx` — monospace scrolling diff display
- **Modify:** `ui/src/lib/queryKeys.ts` — add `visibility` key
- **Modify:** `ui/src/api/heartbeats.ts` — add `fileEventsForActiveRuns()` API function
- **Modify:** `ui/src/context/LiveUpdatesProvider.tsx` — append file.edit events to visibility cache
- **Modify:** `ui/src/App.tsx` — add route
- **Modify:** `ui/src/components/Sidebar.tsx` — add nav item

### Vibe Stack — Adapter
- **Modify:** `agents/paperclip_client.py` — add `emit_run_event()` method
- **Modify:** `agents/tools/file_tools.py` — instrument `FileWriter.execute()` to emit file.edit events

---

## Task 1: Shared — FileEditEventData Type

**Files:**
- Modify: `packages/shared/src/types/heartbeat.ts`
- Modify: `packages/shared/src/types/index.ts`

- [ ] **Step 1: Add FileEditEventData interface**

In `packages/shared/src/types/heartbeat.ts`, add after the existing `HeartbeatRunEvent` interface:

```typescript
/** Payload shape for heartbeat.run.event where eventType === "file.edit" */
export interface FileEditEventData {
  filePath: string;
  editType: "create" | "modify" | "delete";
  diff: string;
  linesAdded: number;
  linesRemoved: number;
  timestamp: string;
}
```

- [ ] **Step 2: Verify the type is already exported via index.ts**

Check that `packages/shared/src/types/index.ts` has a wildcard re-export from `./heartbeat` (it should, since `HeartbeatRunEvent` is already exported). If not, add:

```typescript
export type { FileEditEventData } from "./heartbeat";
```

- [ ] **Step 3: Build shared package**

Run: `cd /home/prime/Repos/paperclip && pnpm --filter @paperclipai/shared build`
Expected: Build succeeds with no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/types/heartbeat.ts packages/shared/src/types/index.ts
git commit -m "feat(shared): add FileEditEventData type for visibility tab"
```

---

## Task 2: Server — POST Endpoint for Adapter-Emitted Run Events

**Files:**
- Modify: `server/src/services/heartbeat.ts`
- Modify: `server/src/routes/agents.ts`

- [ ] **Step 1: Add appendExternalRunEvent to heartbeat service**

In `server/src/services/heartbeat.ts`, add a new function inside `createHeartbeatService()` (before the `return` block at the end of the function, near line ~4700):

```typescript
  async function appendExternalRunEvent(
    runId: string,
    event: {
      eventType: string;
      stream?: "system" | "stdout" | "stderr";
      level?: "info" | "warn" | "error";
      color?: string;
      message?: string;
      payload?: Record<string, unknown>;
    },
  ) {
    const run = await getRun(runId);
    if (!run) return null;
    if (run.status !== "running" && run.status !== "queued") return null;
    const seq = await nextRunEventSeq(runId);
    await appendRunEvent(run, seq, event);
    return { seq };
  }
```

Then add `appendExternalRunEvent` to the returned service object (in the `return { ... }` block):

```typescript
    appendExternalRunEvent,
```

- [ ] **Step 2: Add POST route for run events**

In `server/src/routes/agents.ts`, add the new route after the existing `GET /heartbeat-runs/:runId/events` handler (after line ~2340):

```typescript
  router.post("/heartbeat-runs/:runId/events", async (req, res) => {
    const runId = req.params.runId as string;
    const run = await heartbeat.getRun(runId);
    if (!run) {
      res.status(404).json({ error: "Heartbeat run not found" });
      return;
    }
    assertCompanyAccess(req, run.companyId);

    const { eventType, stream, level, color, message, payload } = req.body ?? {};
    if (!eventType || typeof eventType !== "string") {
      res.status(400).json({ error: "eventType is required" });
      return;
    }

    const result = await heartbeat.appendExternalRunEvent(runId, {
      eventType,
      stream,
      level,
      color,
      message,
      payload,
    });

    if (!result) {
      res.status(409).json({ error: "Run is not active" });
      return;
    }

    res.status(201).json(result);
  });
```

- [ ] **Step 3: Verify server builds**

Run: `cd /home/prime/Repos/paperclip && pnpm --filter server build`
Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add server/src/services/heartbeat.ts server/src/routes/agents.ts
git commit -m "feat(server): add POST endpoint for adapter-emitted run events"
```

---

## Task 3: Server — Active File Events Hydration Endpoint

**Files:**
- Modify: `server/src/services/heartbeat.ts`
- Modify: `server/src/routes/agents.ts`

- [ ] **Step 1: Add listFileEventsForActiveRuns to heartbeat service**

In `server/src/services/heartbeat.ts`, add a new function inside `createHeartbeatService()` (near the other list functions):

```typescript
  async function listFileEventsForActiveRuns(companyId: string) {
    const activeRuns = await db
      .select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          inArray(heartbeatRuns.status, ["queued", "running"]),
        ),
      );

    if (activeRuns.length === 0) return {};

    const runIds = activeRuns.map((r) => r.id);
    const events = await db
      .select()
      .from(heartbeatRunEvents)
      .where(
        and(
          inArray(heartbeatRunEvents.runId, runIds),
          eq(heartbeatRunEvents.eventType, "file.edit"),
        ),
      )
      .orderBy(asc(heartbeatRunEvents.seq));

    const grouped: Record<string, { agentId: string; events: typeof events }> = {};
    const agentByRun = Object.fromEntries(activeRuns.map((r) => [r.id, r.agentId]));

    for (const event of events) {
      if (!grouped[event.runId]) {
        grouped[event.runId] = { agentId: agentByRun[event.runId]!, events: [] };
      }
      grouped[event.runId].events.push(event);
    }

    return grouped;
  }
```

Add `listFileEventsForActiveRuns` to the returned service object.

- [ ] **Step 2: Add GET route for active file events**

In `server/src/routes/agents.ts`, add the route in the company-scoped section (near the existing `GET /companies/:companyId/live-runs`):

```typescript
  router.get("/companies/:companyId/heartbeat-runs/active/file-events", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const result = await heartbeat.listFileEventsForActiveRuns(companyId);
    res.json({ runs: result });
  });
```

- [ ] **Step 3: Verify server builds**

Run: `cd /home/prime/Repos/paperclip && pnpm --filter server build`
Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add server/src/services/heartbeat.ts server/src/routes/agents.ts
git commit -m "feat(server): add hydration endpoint for active run file events"
```

---

## Task 4: UI — API Function + Query Keys

**Files:**
- Modify: `ui/src/api/heartbeats.ts`
- Modify: `ui/src/lib/queryKeys.ts`

- [ ] **Step 1: Add fileEventsForActiveRuns to heartbeatsApi**

In `ui/src/api/heartbeats.ts`, add to the `heartbeatsApi` object (before the closing `}`):

```typescript
  fileEventsForActiveRuns: (companyId: string) =>
    api.get<{
      runs: Record<
        string,
        {
          agentId: string;
          events: Array<{
            runId: string;
            agentId: string;
            seq: number;
            eventType: string;
            payload: Record<string, unknown> | null;
            createdAt: string;
          }>;
        }
      >;
    }>(`/companies/${companyId}/heartbeat-runs/active/file-events`),
```

- [ ] **Step 2: Add visibility query key**

In `ui/src/lib/queryKeys.ts`, add after the `liveRuns` key (line 134):

```typescript
  visibilityFileEvents: (companyId: string) => ["visibility-file-events", companyId] as const,
```

- [ ] **Step 3: Commit**

```bash
git add ui/src/api/heartbeats.ts ui/src/lib/queryKeys.ts
git commit -m "feat(ui): add visibility file events API and query keys"
```

---

## Task 5: UI — DiffView Component

**Files:**
- Create: `ui/src/components/DiffView.tsx`

- [ ] **Step 1: Create DiffView component**

Create `ui/src/components/DiffView.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

interface DiffViewProps {
  /** Array of unified diff lines (prefixed with +, -, or space) */
  lines: string[];
  className?: string;
}

export function DiffView({ lines, className }: DiffViewProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    if (autoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [lines.length, autoScroll]);

  function handleScroll() {
    const el = containerRef.current;
    if (!el) return;
    // If scrolled within 40px of the bottom, re-enable auto-scroll
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(nearBottom);
  }

  return (
    <ScrollArea className={cn("h-full", className)}>
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto"
      >
        <pre className="p-2 text-xs font-mono leading-relaxed">
          {lines.map((line, i) => {
            const isAdd = line.startsWith("+");
            const isRemove = line.startsWith("-");
            return (
              <div
                key={i}
                className={cn(
                  "px-1 -mx-1 rounded-sm",
                  isAdd && "bg-green-500/15 text-green-700 dark:text-green-400",
                  isRemove && "bg-red-500/15 text-red-700 dark:text-red-400",
                  !isAdd && !isRemove && "text-muted-foreground",
                )}
              >
                {line || "\u00A0"}
              </div>
            );
          })}
          <div ref={bottomRef} />
        </pre>
      </div>
    </ScrollArea>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add ui/src/components/DiffView.tsx
git commit -m "feat(ui): add DiffView component for rolling diff display"
```

---

## Task 6: UI — FileCard Component

**Files:**
- Create: `ui/src/components/FileCard.tsx`

- [ ] **Step 1: Create FileCard component**

Create `ui/src/components/FileCard.tsx`:

```tsx
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DiffView } from "./DiffView";
import { cn } from "@/lib/utils";

export interface FileEditEvent {
  filePath: string;
  editType: "create" | "modify" | "delete";
  diff: string;
  linesAdded: number;
  linesRemoved: number;
  timestamp: string;
  seq: number;
}

interface FileCardProps {
  filePath: string;
  events: FileEditEvent[];
  className?: string;
}

const EDIT_TYPE_STYLES: Record<string, { label: string; variant: "default" | "secondary" | "destructive" }> = {
  create: { label: "CREATE", variant: "default" },
  modify: { label: "MODIFY", variant: "secondary" },
  delete: { label: "DELETE", variant: "destructive" },
};

export function FileCard({ filePath, events, className }: FileCardProps) {
  const latestEvent = events[events.length - 1];
  if (!latestEvent) return null;

  const totalAdded = events.reduce((sum, e) => sum + e.linesAdded, 0);
  const totalRemoved = events.reduce((sum, e) => sum + e.linesRemoved, 0);
  const editStyle = EDIT_TYPE_STYLES[latestEvent.editType] ?? EDIT_TYPE_STYLES.modify;

  // Accumulate all diff lines across events
  const allDiffLines = events.flatMap((e) => e.diff.split("\n"));

  return (
    <Card className={cn("w-80 shrink-0 flex flex-col", className)}>
      <CardHeader className="p-3 pb-2 space-y-1">
        <div className="flex items-center justify-between gap-2">
          <span
            className="text-sm font-mono font-medium truncate"
            title={filePath}
          >
            {filePath}
          </span>
          <Badge variant={editStyle.variant} className="shrink-0 text-[10px] px-1.5 py-0">
            {editStyle.label}
          </Badge>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="text-green-600 dark:text-green-400">+{totalAdded}</span>
          <span className="text-red-600 dark:text-red-400">-{totalRemoved}</span>
        </div>
      </CardHeader>
      <CardContent className="p-0 flex-1 min-h-0">
        <div className="h-48 border-t">
          <DiffView lines={allDiffLines} className="h-full" />
        </div>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add ui/src/components/FileCard.tsx
git commit -m "feat(ui): add FileCard component for visibility grid"
```

---

## Task 7: UI — AgentFileRow Component

**Files:**
- Create: `ui/src/components/AgentFileRow.tsx`

- [ ] **Step 1: Create AgentFileRow component**

Create `ui/src/components/AgentFileRow.tsx`:

```tsx
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { FileCard, type FileEditEvent } from "./FileCard";

interface AgentFileRowProps {
  agentName: string;
  issueTitle?: string;
  issueId?: string | null;
  files: Map<string, FileEditEvent[]>;
  runStatus: string;
}

export function AgentFileRow({ agentName, issueTitle, issueId, files, runStatus }: AgentFileRowProps) {
  const isActive = runStatus === "running" || runStatus === "queued";

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        {isActive ? (
          <span className="relative flex h-2.5 w-2.5 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-400 opacity-70" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-cyan-500" />
          </span>
        ) : (
          <span className="inline-flex h-2.5 w-2.5 rounded-full bg-muted-foreground/35" />
        )}
        <span className="text-sm font-semibold">{agentName}</span>
        {issueTitle && (
          <span className="text-xs text-muted-foreground truncate">
            {issueId ? `— ${issueTitle}` : `— ${issueTitle}`}
          </span>
        )}
      </div>

      {files.size === 0 ? (
        <p className="text-xs text-muted-foreground pl-5">
          {isActive ? "Running — no file edits yet" : "Finished"}
        </p>
      ) : (
        <ScrollArea className="w-full">
          <div className="flex gap-3 pb-3 pl-5">
            {Array.from(files.entries()).map(([filePath, events]) => (
              <FileCard key={filePath} filePath={filePath} events={events} />
            ))}
          </div>
          <ScrollBar orientation="horizontal" />
        </ScrollArea>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add ui/src/components/AgentFileRow.tsx
git commit -m "feat(ui): add AgentFileRow component for visibility grid"
```

---

## Task 8: UI — Visibility Page + WebSocket Integration

**Files:**
- Create: `ui/src/pages/Visibility.tsx`
- Modify: `ui/src/context/LiveUpdatesProvider.tsx`

- [ ] **Step 1: Add file.edit event handler to LiveUpdatesProvider**

In `ui/src/context/LiveUpdatesProvider.tsx`, modify the `handleLiveEvent` function. Find the block that currently returns early for `heartbeat.run.event` (around line 637-639):

```typescript
  if (event.type === "heartbeat.run.event") {
    return;
  }
```

Replace with:

```typescript
  if (event.type === "heartbeat.run.event") {
    const eventType = readString(payload.eventType);
    if (eventType === "file.edit") {
      queryClient.setQueryData<Array<Record<string, unknown>>>(
        queryKeys.visibilityFileEvents(expectedCompanyId),
        (old) => [...(old ?? []), payload],
      );
    }
    return;
  }
```

This appends incoming file.edit events to the React Query cache, which the Visibility page reads.

- [ ] **Step 2: Create Visibility page**

Create `ui/src/pages/Visibility.tsx`:

```tsx
import { useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye } from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { heartbeatsApi } from "../api/heartbeats";
import { queryKeys } from "../lib/queryKeys";
import { AgentFileRow } from "../components/AgentFileRow";
import type { FileEditEvent } from "../components/FileCard";
import type { LiveRunForIssue } from "../api/heartbeats";

function parseFileEditPayload(payload: Record<string, unknown>): {
  runId: string;
  agentId: string;
  event: FileEditEvent;
} | null {
  const data = payload.payload as Record<string, unknown> | null;
  const runId = payload.runId as string;
  const agentId = payload.agentId as string;
  if (!data || !runId) return null;

  return {
    runId,
    agentId,
    event: {
      filePath: (data.filePath as string) ?? "unknown",
      editType: (data.editType as FileEditEvent["editType"]) ?? "modify",
      diff: (data.diff as string) ?? "",
      linesAdded: (data.linesAdded as number) ?? 0,
      linesRemoved: (data.linesRemoved as number) ?? 0,
      timestamp: (data.timestamp as string) ?? new Date().toISOString(),
      seq: (payload.seq as number) ?? 0,
    },
  };
}

export function Visibility() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  useEffect(() => {
    setBreadcrumbs([{ label: "Visibility" }]);
  }, [setBreadcrumbs]);

  // Fetch active runs for agent metadata
  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(selectedCompanyId!),
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 10_000,
  });

  // Hydrate file events for runs already in progress
  const { data: hydrated } = useQuery({
    queryKey: [...queryKeys.visibilityFileEvents(selectedCompanyId!), "hydration"],
    queryFn: () => heartbeatsApi.fileEventsForActiveRuns(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchOnMount: true,
    staleTime: 0,
  });

  // Real-time file events appended by LiveUpdatesProvider
  const wsEvents = queryClient.getQueryData<Array<Record<string, unknown>>>(
    queryKeys.visibilityFileEvents(selectedCompanyId!),
  ) ?? [];

  // Build agent -> file -> events map
  const agentFiles = useMemo(() => {
    const map = new Map<string, { run: LiveRunForIssue | undefined; files: Map<string, FileEditEvent[]> }>();

    // Initialize from live runs
    for (const run of liveRuns ?? []) {
      if (!map.has(run.id)) {
        map.set(run.id, { run, files: new Map() });
      }
    }

    // Merge hydrated events
    if (hydrated?.runs) {
      for (const [runId, { events }] of Object.entries(hydrated.runs)) {
        if (!map.has(runId)) {
          const run = liveRuns?.find((r) => r.id === runId);
          map.set(runId, { run, files: new Map() });
        }
        const entry = map.get(runId)!;
        for (const ev of events) {
          const data = ev.payload as Record<string, unknown> | null;
          if (!data) continue;
          const filePath = (data.filePath as string) ?? "unknown";
          const existing = entry.files.get(filePath) ?? [];
          existing.push({
            filePath,
            editType: (data.editType as FileEditEvent["editType"]) ?? "modify",
            diff: (data.diff as string) ?? "",
            linesAdded: (data.linesAdded as number) ?? 0,
            linesRemoved: (data.linesRemoved as number) ?? 0,
            timestamp: (data.timestamp as string) ?? "",
            seq: ev.seq,
          });
          entry.files.set(filePath, existing);
        }
      }
    }

    // Merge real-time WebSocket events
    for (const payload of wsEvents) {
      const parsed = parseFileEditPayload(payload);
      if (!parsed) continue;
      if (!map.has(parsed.runId)) {
        const run = liveRuns?.find((r) => r.id === parsed.runId);
        map.set(parsed.runId, { run, files: new Map() });
      }
      const entry = map.get(parsed.runId)!;
      const existing = entry.files.get(parsed.event.filePath) ?? [];
      // Dedupe by seq
      if (!existing.some((e) => e.seq === parsed.event.seq)) {
        existing.push(parsed.event);
        entry.files.set(parsed.event.filePath, existing);
      }
    }

    return map;
  }, [liveRuns, hydrated, wsEvents]);

  // Clear stale visibility cache when runs finish
  useEffect(() => {
    if (!selectedCompanyId) return;
    const activeRunIds = new Set((liveRuns ?? []).map((r) => r.id));
    queryClient.setQueryData<Array<Record<string, unknown>>>(
      queryKeys.visibilityFileEvents(selectedCompanyId),
      (old) => (old ?? []).filter((e) => activeRunIds.has(e.runId as string)),
    );
  }, [liveRuns, selectedCompanyId, queryClient]);

  if (!selectedCompanyId) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
        <Eye className="h-10 w-10 mb-2 opacity-40" />
        <p>Select a company to view agent activity</p>
      </div>
    );
  }

  const hasAnyRuns = agentFiles.size > 0;

  return (
    <div className="p-6 space-y-6">
      {!hasAnyRuns ? (
        <div className="flex flex-col items-center justify-center h-[60vh] text-muted-foreground">
          <Eye className="h-10 w-10 mb-2 opacity-40" />
          <p className="text-sm">No active runs</p>
        </div>
      ) : (
        Array.from(agentFiles.entries()).map(([runId, { run, files }]) => (
          <AgentFileRow
            key={runId}
            agentName={run?.agentName ?? "Unknown Agent"}
            issueTitle={run?.triggerDetail ?? undefined}
            issueId={run?.issueId}
            files={files}
            runStatus={run?.status ?? "running"}
          />
        ))
      )}
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add ui/src/pages/Visibility.tsx ui/src/context/LiveUpdatesProvider.tsx
git commit -m "feat(ui): add Visibility page with real-time file event aggregation"
```

---

## Task 9: UI — Routing + Sidebar Navigation

**Files:**
- Modify: `ui/src/App.tsx`
- Modify: `ui/src/components/Sidebar.tsx`

- [ ] **Step 1: Add Visibility import to App.tsx**

In `ui/src/App.tsx`, add the import alongside the other page imports (near line 41):

```typescript
import { Visibility } from "./pages/Visibility";
```

- [ ] **Step 2: Add route in boardRoutes()**

In `ui/src/App.tsx`, inside the `boardRoutes()` function, add the route in the work section (near the `improvements` route, around line 155):

```typescript
<Route path="visibility" element={<Visibility />} />
```

- [ ] **Step 3: Add unprefixed redirect**

In `ui/src/App.tsx`, add a top-level redirect route (in the same section as the other `UnprefixedBoardRedirect` routes):

```typescript
<Route path="visibility" element={<UnprefixedBoardRedirect />} />
```

- [ ] **Step 4: Add Sidebar nav item**

In `ui/src/components/Sidebar.tsx`, add the `Eye` import to the lucide-react imports at the top:

```typescript
import { Eye } from "lucide-react";
```

Then add the nav item in the Work section (after Improvements, around line 122):

```typescript
<SidebarNavItem to="/visibility" label="Visibility" icon={Eye} />
```

- [ ] **Step 5: Verify UI builds**

Run: `cd /home/prime/Repos/paperclip && pnpm --filter ui build`
Expected: Build succeeds.

- [ ] **Step 6: Commit**

```bash
git add ui/src/App.tsx ui/src/components/Sidebar.tsx
git commit -m "feat(ui): add Visibility tab routing and sidebar navigation"
```

---

## Task 10: Vibe Stack — PaperclipClient.emit_run_event()

**Files:**
- Modify: `agents/paperclip_client.py` (in `/home/prime/Repos/Vibe-Stack/`)

- [ ] **Step 1: Add emit_run_event method**

In `agents/paperclip_client.py`, add the method to the `PaperclipClient` class (after `add_comment`, around line 467):

```python
    def emit_run_event(
        self,
        event_type: str,
        data: Dict[str, Any],
        message: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        """POST /api/heartbeat-runs/{runId}/events — emit a run event.

        Best-effort: returns None on failure instead of raising.
        Requires self.run_id to be set (heartbeat mode).
        """
        if not self.run_id:
            return None
        try:
            result = self._request(
                "POST",
                f"/api/heartbeat-runs/{self.run_id}/events",
                json_body={
                    "eventType": event_type,
                    "message": message,
                    "payload": data,
                },
            )
            return result
        except (PaperclipAPIError, requests.RequestException) as exc:
            logger.debug("emit_run_event failed (best-effort): %s", exc)
            return None
```

- [ ] **Step 2: Write test**

In `tests/test_paperclip_client.py`, add:

```python
def test_emit_run_event_success(mock_server):
    """emit_run_event posts to the run events endpoint."""
    client = PaperclipClient(
        api_url=mock_server.url,
        api_key="test-key",
        agent_id="agent-1",
        company_id="company-1",
        run_id="run-1",
    )
    mock_server.expect(
        "POST",
        "/api/heartbeat-runs/run-1/events",
        response={"seq": 5},
        status=201,
    )
    result = client.emit_run_event("file.edit", {"filePath": "src/main.py"})
    assert result is not None
    assert result["seq"] == 5


def test_emit_run_event_best_effort_on_failure(mock_server):
    """emit_run_event returns None on API errors instead of raising."""
    client = PaperclipClient(
        api_url=mock_server.url,
        api_key="test-key",
        agent_id="agent-1",
        company_id="company-1",
        run_id="run-1",
    )
    mock_server.expect(
        "POST",
        "/api/heartbeat-runs/run-1/events",
        response={"error": "Run not active"},
        status=409,
    )
    result = client.emit_run_event("file.edit", {"filePath": "src/main.py"})
    assert result is None


def test_emit_run_event_skips_without_run_id():
    """emit_run_event returns None when run_id is not set."""
    client = PaperclipClient(
        api_url="http://localhost:3100",
        api_key="test-key",
        agent_id="agent-1",
        company_id="company-1",
        run_id="",
    )
    result = client.emit_run_event("file.edit", {"filePath": "src/main.py"})
    assert result is None
```

- [ ] **Step 3: Run tests**

Run: `cd /home/prime/Repos/Vibe-Stack && python -m pytest tests/test_paperclip_client.py -x -q --no-header -k "emit_run_event"`
Expected: 3 tests pass.

- [ ] **Step 4: Commit**

```bash
git add agents/paperclip_client.py tests/test_paperclip_client.py
git commit -m "feat(vibe): add emit_run_event to PaperclipClient"
```

---

## Task 11: Vibe Stack — FileWriter Event Emission

**Files:**
- Modify: `agents/tools/file_tools.py` (in `/home/prime/Repos/Vibe-Stack/`)

- [ ] **Step 1: Add file.edit event emission to FileWriter.execute()**

In `agents/tools/file_tools.py`, modify the `FileWriter` class.

Add imports at the top of the file (if not already present):

```python
import difflib
```

Add a helper method to the `FileWriter` class:

```python
    def _emit_file_edit_event(
        self,
        file_path: str,
        edit_type: str,
        old_content: str,
        new_content: str,
    ) -> None:
        """Best-effort emission of file.edit event to Paperclip."""
        try:
            from .registry import _reg
            client = getattr(_reg, "_paperclip_client", None)
            if client is None:
                return

            # Compute workspace-relative path
            workspace = os.environ.get("WORKSPACE_DIR", "")
            rel_path = file_path
            if workspace and file_path.startswith(workspace):
                rel_path = os.path.relpath(file_path, workspace)

            # Compute unified diff, truncate to last 50 lines
            diff_lines = list(difflib.unified_diff(
                old_content.splitlines(keepends=True),
                new_content.splitlines(keepends=True),
                fromfile=rel_path,
                tofile=rel_path,
                lineterm="",
            ))
            truncated = diff_lines[-50:] if len(diff_lines) > 50 else diff_lines

            added = sum(1 for l in diff_lines if l.startswith("+") and not l.startswith("+++"))
            removed = sum(1 for l in diff_lines if l.startswith("-") and not l.startswith("---"))

            client.emit_run_event(
                event_type="file.edit",
                data={
                    "filePath": rel_path,
                    "editType": edit_type,
                    "diff": "\n".join(truncated),
                    "linesAdded": added,
                    "linesRemoved": removed,
                    "timestamp": __import__("datetime").datetime.utcnow().isoformat() + "Z",
                },
                message=f"{edit_type.capitalize()} {rel_path} (+{added} -{removed})",
            )
        except Exception:
            pass  # Best-effort, never block file writes
```

Then modify `execute()` to capture old content and call the emitter. In the `execute` method, **before** `path.write_text(content, encoding=encoding)` (around line 370), read the existing content:

```python
        # Capture old content for diff (best-effort)
        old_content = ""
        edit_type = "create"
        if path.exists():
            try:
                old_content = path.read_text(encoding=encoding)
                edit_type = "modify"
            except (OSError, UnicodeDecodeError):
                pass
```

Then **after** the successful write and before the return statement:

```python
        # Emit file.edit event (best-effort, non-blocking)
        self._emit_file_edit_event(str(path), edit_type, old_content, content)
```

- [ ] **Step 2: Write test**

In `tests/test_tool_system.py` (or a new `tests/test_file_tools_events.py`), add:

```python
import os
import tempfile
from unittest.mock import MagicMock, patch

from agents.tools.file_tools import FileWriter


def test_file_writer_emits_file_edit_event(tmp_path):
    """FileWriter emits a file.edit event on successful write."""
    mock_client = MagicMock()
    mock_client.emit_run_event.return_value = {"seq": 1}

    writer = FileWriter(allowed_dirs=[tmp_path])

    with patch("agents.tools.file_tools._reg") as mock_reg:
        mock_reg._paperclip_client = mock_client
        mock_reg._validate_file_path.return_value = (True, None)

        target = str(tmp_path / "test.py")
        result = writer.execute(file_path=target, content="print('hello')")

    assert result.success is True
    mock_client.emit_run_event.assert_called_once()
    call_kwargs = mock_client.emit_run_event.call_args
    assert call_kwargs.kwargs["event_type"] == "file.edit"
    assert call_kwargs.kwargs["data"]["editType"] == "create"
    assert call_kwargs.kwargs["data"]["linesAdded"] >= 1


def test_file_writer_event_failure_does_not_block_write(tmp_path):
    """If event emission fails, the file write still succeeds."""
    mock_client = MagicMock()
    mock_client.emit_run_event.side_effect = RuntimeError("network error")

    writer = FileWriter(allowed_dirs=[tmp_path])

    with patch("agents.tools.file_tools._reg") as mock_reg:
        mock_reg._paperclip_client = mock_client
        mock_reg._validate_file_path.return_value = (True, None)

        target = str(tmp_path / "test.py")
        result = writer.execute(file_path=target, content="print('hello')")

    assert result.success is True
    assert (tmp_path / "test.py").read_text() == "print('hello')"
```

- [ ] **Step 3: Run tests**

Run: `cd /home/prime/Repos/Vibe-Stack && python -m pytest tests/test_file_tools_events.py -x -q --no-header`
Expected: 2 tests pass.

- [ ] **Step 4: Commit**

```bash
git add agents/tools/file_tools.py tests/test_file_tools_events.py
git commit -m "feat(vibe): emit file.edit events from FileWriter"
```

---

## Task 12: Integration Verification

- [ ] **Step 1: Build all Paperclip packages**

```bash
cd /home/prime/Repos/paperclip
pnpm build
```

Expected: All packages build without errors.

- [ ] **Step 2: Run Vibe Stack tests**

```bash
cd /home/prime/Repos/Vibe-Stack
python -m pytest tests/ -x -m "not e2e" --no-header -q
```

Expected: All tests pass.

- [ ] **Step 3: Manual smoke test**

1. Build and deploy the updated Paperclip image
2. Verify the Visibility tab appears in the sidebar
3. Verify the empty state renders when no runs are active
4. Trigger a heartbeat run and verify file cards appear in real-time

- [ ] **Step 4: Final commit (if any fixups needed)**

```bash
git add -A
git commit -m "fix: integration fixups for visibility tab"
```
