export function shouldOfferRuntimeConnectionsMcp(input: { runtimeToolDelivery: string; hasIssue: boolean }) {
  return input.runtimeToolDelivery === "native_mcp" && input.hasIssue;
}
