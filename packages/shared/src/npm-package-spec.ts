export interface ParsedNpmPackageSpec {
  packageName: string;
  version?: string;
}

/** Split a conventional npm package specifier into its name and version. */
export function parseNpmPackageSpec(
  packageSpec: string,
  explicitVersion?: string,
): ParsedNpmPackageSpec {
  const value = packageSpec.trim();
  const suppliedVersion = explicitVersion?.trim() || undefined;
  const separator = value.startsWith("@")
    ? value.indexOf("@", value.indexOf("/") + 1)
    : value.lastIndexOf("@");

  if (separator <= 0) {
    return { packageName: value, version: suppliedVersion };
  }

  const packageName = value.slice(0, separator);
  const inlineVersion = value.slice(separator + 1).trim();
  if (!inlineVersion) {
    throw new Error("npm package version cannot be empty");
  }
  if (suppliedVersion && suppliedVersion !== inlineVersion) {
    throw new Error(
      `npm package version ${inlineVersion} conflicts with --version ${suppliedVersion}`,
    );
  }

  return { packageName, version: suppliedVersion ?? inlineVersion };
}
