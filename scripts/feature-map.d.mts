export interface FeatureCapability {
  id: string;
  label: string;
  description: string;
  verification?: { scope: string; storybook: string; production: string; sources: string };
}
export interface FeatureMapIndex {
  sections: Array<{
    title: string;
    features: Array<{ id: string; title: string; description: string; capabilities: FeatureCapability[] }>;
  }>;
}
export function featureIndex(root: string): FeatureMapIndex;
export function sidebarLabel(title: string): string;
export function mapIndexes(index: FeatureMapIndex): Map<string, string>;
export function pageInventory(root: string, index: FeatureMapIndex): { pages: Array<{ file: string; features: string[] }> };
