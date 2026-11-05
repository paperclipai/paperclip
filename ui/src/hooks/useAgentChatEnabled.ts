/** Agent Chat is a standard product surface. Keep this facade for existing
 * consumers without making navigation wait for experimental settings. */
export function useAgentChatEnabled() {
  return { enabled: true, loaded: true };
}
