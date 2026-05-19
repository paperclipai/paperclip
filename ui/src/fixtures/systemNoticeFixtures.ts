import type {
  SystemNoticeMetadataSection,
  SystemNoticeProps,
} from "../components/SystemNotice";

export type SystemNoticeFixture = {
  id: string;
  caption: string;
} & SystemNoticeProps;

const HANDOFF_METADATA: SystemNoticeMetadataSection[] = [
  {
    title: "Recovery owner",
    rows: [
      {
        kind: "issue",
        label: "Recovery issue",
        identifier: "PAP-3440",
        href: "/PAP/issues/PAP-3440",
        title: "Successful run handoff missing disposition",
      },
      {
        kind: "agent",
        label: "Owner",
        name: "CTO",
        href: "/PAP/agents/cto",
      },
      {
        kind: "text",
        label: "Suggested action",
        value: "Reassign to a recovery agent and pick a disposition.",
      },
    ],
  },
  {
    title: "Run evidence",
    rows: [
      {
        kind: "run",
        label: "Source run",
        runId: "9cdba892-c7ca-4d93-8604-4843873b127c",
        href: "/PAP/agents/codexcoder/runs/9cdba892-c7ca-4d93-8604-4843873b127c",
        status: "succeeded",
      },
      {
        kind: "run",
        label: "Recovery run",
        runId: "61fdb79b-8012-4676-ac71-2971830e126a",
        href: "/PAP/agents/codexcoder/runs/61fdb79b-8012-4676-ac71-2971830e126a",
        status: "failed",
      },
      {
        kind: "text",
        label: "Normalized cause",
        value: "Run completed without issuing a disposition for an in_progress task.",
      },
    ],
  },
];

const REQUIRED_METADATA: SystemNoticeMetadataSection[] = [
  {
    title: "Required action",
    rows: [
      {
        kind: "issue",
        label: "Source issue",
        identifier: "PAP-3440",
        href: "/PAP/issues/PAP-3440",
        title: "Successful run handoff missing disposition",
      },
      {
        kind: "agent",
        label: "Assignee",
        name: "CodexCoder",
        href: "/PAP/agents/codexcoder",
      },
      {
        kind: "text",
        label: "Next step",
        value: "Pick done, blocked, or in_review and post a one-line rationale.",
      },
    ],
  },
  {
    title: "Run context",
    rows: [
      {
        kind: "run",
        label: "Successful run",
        runId: "9cdba892-c7ca-4d93-8604-4843873b127c",
        href: "/PAP/agents/codexcoder/runs/9cdba892-c7ca-4d93-8604-4843873b127c",
        status: "succeeded",
      },
      {
        kind: "code",
        label: "Status before",
        value: "in_progress",
      },
    ],
  },
];

const NEUTRAL_METADATA: SystemNoticeMetadataSection[] = [
  {
    rows: [
      {
        kind: "agent",
        label: "Reassigned to",
        name: "ClaudeFixer",
        href: "/PAP/agents/claudefixer",
      },
      {
        kind: "agent",
        label: "From",
        name: "CodexCoder",
        href: "/PAP/agents/codexcoder",
      },
      {
        kind: "text",
        label: "Reason",
        value: "Manual reassignment requested by Board.",
      },
    ],
  },
];

export const systemNoticeFixtures: readonly SystemNoticeFixture[] = [
  {
    id: "warning-collapsed",
    caption: "Warning · collapsed (default)",
    tone: "warning",
    label: "System warning",
    source: { label: "Paperclip", href: "/PAP/agents" },
    timestamp: "2026-05-04T16:32:00.000Z",
    body: "Paperclip needs a disposition before this issue can continue.",
    metadata: REQUIRED_METADATA,
    detailsDefaultOpen: false,
  },
  {
    id: "warning-expanded",
    caption: "Warning · expanded",
    tone: "warning",
    label: "System warning",
    source: { label: "Paperclip", href: "/PAP/agents" },
    timestamp: "2026-05-04T16:32:00.000Z",
    body: "Paperclip needs a disposition before this issue can continue.",
    metadata: REQUIRED_METADATA,
    detailsDefaultOpen: true,
  },
  {
    id: "danger-collapsed",
    caption: "Danger · collapsed (default)",
    tone: "danger",
    label: "System alert",
    source: { label: "Paperclip", href: "/PAP/agents" },
    timestamp: "2026-05-04T16:48:00.000Z",
    body: "Paperclip could not resolve this issue's missing disposition automatically. The issue is blocked on a recovery owner.",
    metadata: HANDOFF_METADATA,
    detailsDefaultOpen: false,
  },
  {
    id: "danger-expanded",
    caption: "Danger · expanded",
    tone: "danger",
    label: "System alert",
    source: { label: "Paperclip", href: "/PAP/agents" },
    timestamp: "2026-05-04T16:48:00.000Z",
    body: "Paperclip could not resolve this issue's missing disposition automatically. The issue is blocked on a recovery owner.",
    metadata: HANDOFF_METADATA,
    detailsDefaultOpen: true,
  },
  {
    id: "neutral-collapsed",
    caption: "Neutral · collapsed (default)",
    tone: "neutral",
    label: "System notice",
    source: { label: "Paperclip" },
    timestamp: "2026-05-04T15:10:00.000Z",
    body: "Reassigned to ClaudeFixer.",
    metadata: NEUTRAL_METADATA,
    detailsDefaultOpen: false,
  },
  {
    id: "neutral-expanded",
    caption: "Neutral · expanded",
    tone: "neutral",
    label: "System notice",
    source: { label: "Paperclip" },
    timestamp: "2026-05-04T15:10:00.000Z",
    body: "Reassigned to ClaudeFixer.",
    metadata: NEUTRAL_METADATA,
    detailsDefaultOpen: true,
  },
  {
    id: "warning-no-details",
    caption: "Warning · no metadata (Details affordance hidden)",
    tone: "warning",
    label: "System warning",
    source: { label: "Paperclip" },
    timestamp: "2026-05-04T17:02:00.000Z",
    body: "This run paused while waiting on board approval.",
  },
];
