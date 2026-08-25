import type { PluginPageProps } from "@paperclipai/plugin-sdk/ui";
import { WeKnoraPage } from "./app.js";

export { WeKnoraPage };

export function SidebarLink() {
  return <a href="./weknora">WeKnora</a>;
}

export function Page(props: PluginPageProps) {
  return <WeKnoraPage {...props} />;
}
