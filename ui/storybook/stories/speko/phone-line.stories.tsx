import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";
import { SpekoPhoneLineForm } from "@/components/voice/SpekoPhoneLine";
import type { VoicePhoneConfiguration } from "@paperclipai/shared";
import { voiceStoryLifecycle } from "../../fixtures/voiceStoryLifecycle";
const configuration: VoicePhoneConfiguration = { number: null, inventory: [{id: "number", phoneNumber: "+12015550123", label: "Company front desk", available: true, inboundReady: true, outboundReady: true, issues: []}] };
const meta = {...voiceStoryLifecycle, title: "Connections/Speko/Incoming phone line", component: SpekoPhoneLineForm, args: {onRefresh: () => {}, onSave: () => {}}, parameters: {layout: "padded"}} satisfies Meta<typeof SpekoPhoneLineForm>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Initial: Story = {args: {configuration}};
export const Loading: Story = {args: {loading: true}};
export const EmptyInventory: Story = {args: {configuration: {number: null, inventory: []}}};
export const Selected: Story = {args: {configuration: {...configuration, number: {id: "number", phoneNumber: "+12015550123", enabled: true}}}};
export const VerificationRequired: Story = {args: {configuration: {...configuration, number: {id: "number", phoneNumber: "+12015550123", enabled: false}, inventory: configuration.inventory.map(n => ({...n, inboundReady: false, issues: ["Business verification required"]}))}}};
export const InsufficientCredits: Story = {args: {configuration: {...configuration, inventory: configuration.inventory.map(n => ({...n, available: false, inboundReady: false, issues: ["Insufficient credits"]}))}, error: "Add credits to your Speko workspace before enabling this number."}};
export const ProviderFailure: Story = {args: {error: "Speko is unavailable. Refresh numbers after the connection recovers."}};
export const LongLabels: Story = {args: {configuration: {...configuration, inventory: configuration.inventory.map(n => ({...n, label: "Customer support, sales and operations company phone line with an unusually long descriptive name"}))}}};
function Interactive() { const [value, setValue] = useState(configuration), [saved, setSaved] = useState(false); return <SpekoPhoneLineForm configuration={value} saved={saved} onRefresh={() => {}} onSave={input => {setValue({...value, number: {id: input.numberId, phoneNumber: "+12015550123", enabled: input.enabled, guestIntake: input.guestIntake}}); setSaved(true);}} />; }
export const KeyboardSave: Story = {render: () => <Interactive />, play: async ({canvasElement}) => {const c = within(canvasElement); await userEvent.click(c.getByRole("button", {name: "Save incoming call setting"})); await expect(c.getByRole("alert")).toHaveTextContent("Choose an available"); const select = c.getByRole("combobox", {name: "Company phone number"}); await userEvent.selectOptions(select, "number"); select.focus(); await userEvent.tab(); await expect(c.getByRole("checkbox", {name: "Enable incoming calls on this number"})).toHaveFocus(); await userEvent.keyboard(" "); await userEvent.tab(); await userEvent.tab(); await userEvent.keyboard("{Enter}"); await expect(c.getAllByRole("status").at(-1)!).toHaveTextContent("Incoming call setting saved");}};

export const GuestIntake: Story = {args: {configuration: {...configuration, number: {id: "number", phoneNumber: "+12015550123", enabled: true, guestIntake: true}}}};

export const PrivateTaskApproval: Story = {args: {configuration: {...configuration, number: {id: "number", phoneNumber: "+12015550123", enabled: true, guestIntake: false}}}};

export const SelectedSandbox: Story = {args: {configuration: {...configuration, number: {id: "number", phoneNumber: "+12015550123", enabled: true, guestIntake: true, lowTrustEnvironmentId: "sandbox"}, sandboxEnvironments: [{id: "sandbox", name: "Company phone Daytona sandbox"}]}}, play: async ({canvasElement}) => {await expect(within(canvasElement).getByRole("combobox", {name: "Execution sandbox"})).toHaveValue("sandbox");}};
