import type { ComponentProps } from "react";
import { ConfigSaveBar } from "@/components/ConfigSaveBar";

export function AgentConfigSaveBar(props: ComponentProps<typeof ConfigSaveBar>) {
  return <ConfigSaveBar ariaLabel="Unsaved agent changes" {...props} />;
}
