import { useTranslation } from "@/i18n";
import { SetupWizardNavigation, SetupWizardSidebar } from "../SetupWizard";
export { SetupWizardSidebar as ChatSetupSidebar };
export function ChatSetupNavigation(props: {
  labels?: string[]; step: number; availableStep: number; disabled?: boolean; onSelect: (step: number) => void;
}) {
  const { t } = useTranslation();
  return <SetupWizardNavigation {...props} labels={props.labels ?? [t("sep28Chat.chooseAgent"), t("sep28Chat.connectProvider"), t("sep28Chat.tryIt")]} ariaLabel={t("sep28Chat.connectionSetupProgress")} />;
}
