import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within, fn } from "storybook/test";
import { SpekoCallHistoryView, SpekoCallReport, SpekoCallActivityItem, SpekoUnapprovedCallActivityItem } from "@/components/voice/SpekoCallHistory";
import { callHistoryFixture } from "../../fixtures/spekoCallHistory";
import { voiceStoryLifecycle } from "../../fixtures/voiceStoryLifecycle";
const entry = callHistoryFixture;
const meta = { ...voiceStoryLifecycle, title: "Connections/Speko/Call history", component: SpekoCallHistoryView, args: { onRetry: fn() }, parameters: { layout: "padded" } } satisfies Meta<typeof SpekoCallHistoryView>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Empty: Story = {};
export const Loading: Story = { args: { loading: true } };
export const Failure: Story = { args: { error: "Call history could not be loaded. Check your connection and try again." }, play: async ({canvasElement, args}) => { await userEvent.click(within(canvasElement).getByRole("button", {name: "Try again"})); await expect(args.onRetry).toHaveBeenCalled(); } };
export const Completed: Story = { args: { entries: [entry] } };
export const Active: Story = { args: { entries: [{ ...entry, session: { ...entry.session, state: "active", mode: "browser", endedAt: null }, report: { ...entry.report, status: "pending", transcript: [], costMicroUsd: null } }] } };
export const Failed: Story = { args: { entries: [{ ...entry, session: { ...entry.session, state: "failed", errorCode: "provider_unavailable" } }] } };
export const Missed: Story = { args: { entries: [{ ...entry, session: { ...entry.session, mode: "inbound_phone" }, report: { ...entry.report, transcript: [], durationSeconds: 0 } }] } };
export const TranscriptUnavailable: Story = { render: () => <SpekoCallReport report={{...entry.report, status: "unavailable", transcript: []}} /> };
export const PartialCost: Story = { render: () => <SpekoCallReport report={{...entry.report, costMicroUsd: null, durationSeconds: null}} /> };
export const InterruptedAnswer: Story = { render: () => <SpekoCallReport report={{...entry.report, transcript: entry.report.transcript.map(t => ({...t, interrupted: t.speaker === "agent"}))}} /> };
export const LongConversation: Story = { render: () => <SpekoCallReport report={{...entry.report, transcript: Array.from({length: 30}, (_,index) => ({...entry.report.transcript[index % 2]!, id: `turn-${index}`, index, text: entry.report.transcript[index % 2]!.text.repeat(8)}))}} /> };
export const KeyboardDisclosure: Story = { args: { entries: [entry] }, play: async ({canvasElement}) => { const c=within(canvasElement); const summary=canvasElement.querySelector("summary")!; (summary as HTMLElement).focus(); await userEvent.click(summary); await expect(c.getByRole("link", {name: "Conversation task"})).toBeVisible(); await expect(c.getByRole("list", {name: "Call transcript"})).toBeVisible(); await userEvent.click(summary); await expect(c.getByRole("link", {name: "Conversation task", hidden: true})).not.toBeVisible(); } };

export const EndCallFocus: Story = { render: function FocusFixture() {
  const [ended, setEnded] = useState(false);
  return <SpekoCallHistoryView onRetry={fn()} onEnd={() => setEnded(true)} entries={[{...entry, session: {...entry.session, state: ended ? "ended" : "active", endedAt: ended ? entry.session.endedAt : null}}]} />;
}, play: async ({canvasElement}) => { const c = within(canvasElement); const summary = canvasElement.querySelector("summary")!; await userEvent.click(summary); await userEvent.click(c.getByRole("button", {name: "End call"})); await expect(summary).toHaveFocus(); await expect(summary).toHaveTextContent("Completed"); } };

export const UnapprovedIncoming: Story = {args: {unapprovedCalls: ["ended", "denied", "expired"].map((state, index) => ({id: `missed-${index}`, state: state as "ended" | "denied" | "expired", createdAt: "2026-10-07T17:00:00Z", updatedAt: "2026-10-07T17:02:00Z"}))}};
export const RevokedHistory: Story = {args: {entries: [entry], error: "Your access to this connection has changed."}, play: async ({canvasElement}) => { await expect(within(canvasElement).queryByText("Outgoing call · Completed", {exact: false})).toBeNull(); }};

export const ActivityEntry: Story = { render: () => <SpekoCallActivityItem entry={entry} presentation="activity" /> };
export const ActivityUnapprovedEntry: Story = { render: () => <SpekoUnapprovedCallActivityItem presentation="activity" call={{id: "missed-call", state: "expired", createdAt: "2026-10-07T17:00:00Z", updatedAt: "2026-10-07T17:02:00Z"}} /> };
export const ActivityEndCallFocus: Story = { render: function ActivityFocusFixture() {
  const [ended, setEnded] = useState(false);
  return <SpekoCallActivityItem presentation="activity" onEnd={() => setEnded(true)} entry={{...entry, session: {...entry.session, state: ended ? "ended" : "active", endedAt: ended ? entry.session.endedAt : null}}} />;
}, play: EndCallFocus.play };
