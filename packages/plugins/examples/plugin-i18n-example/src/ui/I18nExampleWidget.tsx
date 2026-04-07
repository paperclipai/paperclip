import { usePluginTranslation } from "@paperclipai/plugin-sdk/ui";
import type { PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";

/**
 * Example dashboard widget demonstrating usePluginTranslation().
 *
 * This component uses the plugin's own namespace "plugin.paperclip.i18n-example.messages"
 * to translate its UI. The namespace is constructed as:
 *   plugin.{pluginKey}.{namespace}
 *
 * When the user switches languages in Settings > General, this widget
 * re-renders with the new language automatically.
 */
export function I18nExampleWidget({ context }: PluginWidgetProps) {
  const { t, language, ready } = usePluginTranslation("plugin.paperclip.i18n-example.messages");

  if (!ready) {
    return <div style={{ padding: 16, opacity: 0.5 }}>Loading translations...</div>;
  }

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
      <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
        {t("widget.title", "i18n Example Widget")}
      </h3>
      <p style={{ margin: 0, fontSize: 13, opacity: 0.7 }}>
        {t("widget.description", "This widget demonstrates plugin i18n with usePluginTranslation().")}
      </p>
      <div style={{ fontSize: 12, opacity: 0.5 }}>
        {t("widget.currentLanguage", { defaultValue: "Current language: {{lang}}", lang: language })}
      </div>
      <div style={{ fontSize: 12, opacity: 0.5 }}>
        {t("widget.companyId", { defaultValue: "Company: {{id}}", id: context.companyId ?? "N/A" })}
      </div>
    </div>
  );
}
