import { useTranslation } from "../i18n";

export function PluginRenderFailure({ name }: { name: string }) {
  const { t } = useTranslation("platform");
  return <>{t("pluginRenderFailed", { name })}</>;
}

export function PluginLauncherTargetFailure({ name, target }: { name: string; target: string }) {
  const { t } = useTranslation("platform");
  return <>{t("pluginTargetUnavailable", { name, target })}</>;
}
