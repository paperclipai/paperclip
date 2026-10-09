import type {Meta, StoryObj} from "@storybook/react-vite";
import {useLayoutEffect, useState} from "react";
import {expect, userEvent, waitFor, within} from "storybook/test";
import {SpekoIncomingCalls, SpekoIncomingCallCard} from "@/components/voice/SpekoIncomingCalls";
import type {VoiceInboundCall} from "@paperclipai/shared";
import {voiceStoryLifecycle} from "../../fixtures/voiceStoryLifecycle";
import {voicePhoneApi} from "@/api/voicePhone";
import {issuesApi} from "@/api/issues";
import {storybookIssues} from "../../fixtures/paperclipData";
import {SpekoQueryFixture, spekoCompanyId, spekoEndpoint, spekoAgent} from "../../fixtures/spekoNative";
const call: VoiceInboundCall = {id: "incoming", state: "awaiting_approval", approvalCode: "123456", createdAt: "2026-10-07T17:00:00Z", expiresAt: "2026-10-07T17:02:00Z", sessionId: null};
const meta = {...voiceStoryLifecycle, title: "Connections/Speko/Live phone approval", component: SpekoIncomingCallCard, args: {call, onDecide: () => {}}, parameters: {layout: "padded"}} satisfies Meta<typeof SpekoIncomingCallCard>;
export default meta;
type Story = StoryObj<typeof meta>;
export const AwaitingApproval: Story = {};
export const ExistingTask: Story = {args: {tasks: [{id: "task", label: "PAP-42 · Review the upcoming release and summarize the remaining verification work"}]}};
export const Confirming: Story = {args: {busy: true}};
export const Approved: Story = {args: {call: {...call, state: "approved"}}};
export const Denied: Story = {args: {call: {...call, state: "denied"}}};
export const Expired: Story = {args: {call: {...call, state: "expired"}}};
export const HungUp: Story = {args: {call: {...call, state: "ended"}}};
export const Failure: Story = {args: {error: "The call ended before approval. Start a new call."}};
function Interactive() {const [value,setValue] = useState(call); return <SpekoIncomingCallCard call={value} onDecide={input => setValue({...value,state: input.approve ? "approved" : "denied"})} />;}
export const KeyboardApprovalAndFocus: Story = {render: () => <Interactive />, play: async ({canvasElement}) => {const c=within(canvasElement), code=c.getByRole("textbox", {name: "Code spoken on your call"}); code.focus(); await userEvent.type(code, "000000"); await userEvent.keyboard("{Enter}"); await expect(c.getByRole("alert")).toHaveTextContent("does not match"); await userEvent.clear(code); await userEvent.type(code, "123456"); await userEvent.keyboard("{Enter}"); await expect(c.getByRole("heading", {name: "Call approved"})).toHaveFocus();}};

export const GuestIntake: Story = {args: {call: {...call, state: "guest_intake", intakeIssueId: "intake-task"}}, play: async ({canvasElement}) => {const c=within(canvasElement); await expect(c.getByRole("heading", {name: "Incoming conversation"})).toBeVisible(); await expect(c.queryByRole("textbox", {name: "Code spoken on your call"})).not.toBeInTheDocument(); await expect(c.getByRole("link", {name: "Open conversation task"})).toHaveAttribute("href", "/issues/intake-task"); await expect(c.getByRole("button", {name: "End call"})).toBeEnabled();}};

function PublicInteractive() {const [value,setValue] = useState<VoiceInboundCall>({...call, state: "guest_intake", intakeIssueId: "intake-task"}); return <SpekoIncomingCallCard call={value} onDecide={() => setValue({...value,state: "ended"})} />;}
export const PublicKeyboardEnd: Story = {render: () => <PublicInteractive />, play: async ({canvasElement}) => {const c=within(canvasElement); c.getByRole("button", {name: "End call"}).focus(); await userEvent.keyboard("{Enter}"); await expect(c.getByRole("heading", {name: "Caller hung up"})).toHaveFocus();}};

function TaskRequestFailure() {
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    const originalIncoming = voicePhoneApi.incoming, originalTasks = issuesApi.list;
    let requests = 0;
    voicePhoneApi.incoming = async () => [call];
    issuesApi.list = async () => {
      if (!requests++) throw new Error("Fixture unavailable");
      return [{...storybookIssues[0]!, id: "ready-task", status: "todo" as const, identifier: "PAP-42", title: "Ready existing conversation"}];
    };
    setReady(true);
    return () => { voicePhoneApi.incoming = originalIncoming; issuesApi.list = originalTasks; };
  }, []);
  return ready ? <SpekoIncomingCalls companyId={spekoCompanyId} endpointId={spekoEndpoint.id} agentId={spekoAgent.id} /> : null;
}
export const TaskListFailureAndRecovery: Story = {
  render: () => <SpekoQueryFixture><TaskRequestFailure /></SpekoQueryFixture>,
  play: async ({canvasElement}) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("alert")).toHaveTextContent("Task list could not be loaded");
    const retry = canvas.getByRole("button", {name: "Retry tasks"}); retry.focus();
    await userEvent.keyboard("{Enter}");
    await expect(await canvas.findByRole("option", {name: "PAP-42 · Ready existing conversation"})).toBeVisible();
    await waitFor(() => expect(canvas.queryByRole("alert")).not.toBeInTheDocument());
  },
};
