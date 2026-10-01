import { RoutineTriggerWizard as ProductionWizard, webhookAgentInstructions as instructions } from "@/components/routine-triggers/TriggerWizard";
import type { ComponentProps } from "react";
export { defaultTriggerDraft, describeSchedule, type TriggerDraft } from "@/components/routine-triggers/TriggerWizard";
export const demoWebhookUrl = "https://acme.paperclip.example/api/routine-triggers/public/0123456789abcdef01234567/fire";
const demoKey = "demo_webhook_key_for_storybook_only";
export function webhookAgentInstructions(sender: "custom" | "github") {
  return instructions(sender, "Verify a deployment", demoWebhookUrl, demoKey);
}
export function RoutineTriggerWizard(props: Pick<ComponentProps<typeof ProductionWizard>, "initialDraft" | "onSaveExit" | "onFinish" | "checkResult">) {
  return <ProductionWizard {...props} routineTitle="Verify a deployment" routineId="routine-webhook-story" webhookUrl={demoWebhookUrl} webhookSecret={demoKey} />;
}
