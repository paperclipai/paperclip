import { pathToFileURL } from "node:url";
import { chatCatalogCases, loadChatCatalogImplementation, loadIdentityBoundaryImplementation, type ChatCatalogDescriptor } from "./chat-catalog-registry.js";

/** Offline admission guard. Load declarations only; never invoke fixture callbacks. */
export async function validateChatCatalogConsistency(
  descriptors: readonly ChatCatalogDescriptor[] = chatCatalogCases,
  importer?: (specifier: string) => Promise<Record<string, unknown>>,
) {
  const failures: string[] = [];
  for (const descriptor of descriptors) {
    try {
      if (descriptor.journeyKind === "browser-boundary") await loadIdentityBoundaryImplementation(descriptor, importer);
      else await loadChatCatalogImplementation(descriptor, importer);
    } catch (error) {
      failures.push(`${descriptor.scenarioId}: ${error instanceof Error ? error.message : "Unknown declaration error"}`);
    }
  }
  if (failures.length) throw new Error(`Chat catalog consistency failed (${failures.length}/${descriptors.length}):\n${failures.join("\n")}`);
  return { descriptorCount: descriptors.length, fixtureCallbacksInvoked: 0 as const };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  validateChatCatalogConsistency().then(receipt => console.log(JSON.stringify(receipt))).catch(error => {
    console.error(error instanceof Error ? error.message : "Chat catalog consistency failed"); process.exitCode = 1;
  });
}
