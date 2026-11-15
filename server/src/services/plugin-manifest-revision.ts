let revision = 0;

export function pluginManifestRevision(): number {
  return revision;
}

export function announcePluginManifestChange(): void {
  revision += 1;
}
