import { createContext } from "react";
import type { NativeVoiceConversationProps } from "./NativeVoiceConversation";
export const VoiceCallContext = createContext<{
  active: boolean;
  open(props: NativeVoiceConversationProps): void;
} | null>(null);
