import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { SpekoPhoneCallbackForm } from "@/components/voice/SpekoPhoneCallback";
import type { VoiceCallbackPreference } from "@paperclipai/shared";
import { voiceStoryLifecycle } from "../fixtures/voiceStoryLifecycle";
const meta = { ...voiceStoryLifecycle, title: "Connections/Speko/Phone callback", component: SpekoPhoneCallbackForm, args: { onSave: () => {} }, parameters: { layout: "padded" } } satisfies Meta<typeof SpekoPhoneCallbackForm>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Initial: Story = {};
export const Loading: Story = { args: { loading: true } };
export const Enabled: Story = { args: { preference: { phoneNumber: "+12015551234", enabled: true } } };
export const Disabled: Story = { args: { preference: { phoneNumber: "+12015551234", enabled: false } } };
export const Saving: Story = { args: { saving: true } };
export const Saved: Story = { args: { saved: true } };
export const ProviderFailure: Story = { args: { error: "Speko calling is unavailable. Check your phone configuration in Speko and try again." } };
function Interactive() {
  const [preference, setPreference] = useState<VoiceCallbackPreference | null>(null);
  return <SpekoPhoneCallbackForm preference={preference} saved={Boolean(preference)} onSave={setPreference} />;
}
export const ValidationAndKeyboardSave: Story = { render: () => <Interactive />, play: async ({ canvasElement }) => {
  const c = within(canvasElement); const number = c.getByRole("textbox", { name: "Your callback number" });
  number.focus(); await userEvent.type(number, "555"); await userEvent.keyboard("{Enter}");
  await expect(c.getByRole("alert")).toHaveTextContent("international"); await expect(number).toHaveAttribute("aria-invalid", "true");
  await userEvent.clear(number); await userEvent.type(number, "+12015551234"); await userEvent.tab();
  await expect(c.getByRole("checkbox")).toHaveFocus(); await userEvent.keyboard(" "); await userEvent.tab();
  await expect(c.getByRole("button", { name: "Save phone setting" })).toHaveFocus(); await userEvent.keyboard("{Enter}");
  await expect(c.getByRole("status")).toHaveTextContent("Callback setting saved");
  await expect(c.getByRole("checkbox")).toBeChecked();
} };
