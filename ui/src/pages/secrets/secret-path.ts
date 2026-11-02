export type SecretPathRow =
  | { kind: "company"; secret: { name: string } }
  | { kind: "user"; definition: { name: string } };

export interface SecretPathFolder {
  name: string;
  path: string;
  secretCount: number;
  folderCount: number;
}

export interface SecretPathBreadcrumb {
  name: string;
  path: string;
}

export interface SecretPathListing<Row extends SecretPathRow> {
  folders: SecretPathFolder[];
  secrets: Row[];
}

const NATURAL_NAME_SORT_OPTIONS: Intl.CollatorOptions = {
  numeric: true,
  sensitivity: "base",
};

export function getSecretPathRowName(row: SecretPathRow): string {
  return row.kind === "company" ? row.secret.name : row.definition.name;
}

export function splitSecretPath(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

export function normalizeSecretPath(path: string): string {
  return splitSecretPath(path).join("/");
}

function startsWithSegments(segments: readonly string[], prefix: readonly string[]): boolean {
  return prefix.every((segment, index) => segments[index] === segment);
}

function compareNames(left: string, right: string): number {
  return left.localeCompare(right, undefined, NATURAL_NAME_SORT_OPTIONS);
}

export function buildSecretPathListing<Row extends SecretPathRow>(
  rows: readonly Row[],
  path: string,
): SecretPathListing<Row> {
  const pathSegments = splitSecretPath(path);
  const entries = rows.map((row) => ({
    row,
    name: getSecretPathRowName(row),
    segments: splitSecretPath(getSecretPathRowName(row)),
  }));
  const folderNames = new Set<string>();
  const secrets: Row[] = [];

  for (const entry of entries) {
    if (!startsWithSegments(entry.segments, pathSegments)) continue;
    const relativeDepth = entry.segments.length - pathSegments.length;
    if (relativeDepth === 0 || relativeDepth === 1) secrets.push(entry.row);
    if (relativeDepth >= 2) folderNames.add(entry.segments[pathSegments.length]);
  }

  const folders = [...folderNames].map((name): SecretPathFolder => {
    const folderSegments = [...pathSegments, name];
    const descendantFolderPaths = new Set<string>();
    let secretCount = 0;

    for (const entry of entries) {
      if (!startsWithSegments(entry.segments, folderSegments)) continue;
      const relativeDepth = entry.segments.length - folderSegments.length;
      if (relativeDepth < 1) continue;
      secretCount += 1;
      for (let depth = 1; depth < relativeDepth; depth += 1) {
        descendantFolderPaths.add(
          entry.segments.slice(folderSegments.length, folderSegments.length + depth).join("/"),
        );
      }
    }

    return {
      name,
      path: folderSegments.join("/"),
      secretCount,
      folderCount: descendantFolderPaths.size,
    };
  });

  folders.sort((left, right) => compareNames(left.name, right.name));
  secrets.sort((left, right) =>
    compareNames(getSecretPathRowName(left), getSecretPathRowName(right)),
  );

  return { folders, secrets };
}

export function buildSecretPathBreadcrumbs(path: string): SecretPathBreadcrumb[] {
  const segments = splitSecretPath(path);
  return segments.map((name, index) => ({
    name,
    path: segments.slice(0, index + 1).join("/"),
  }));
}

export function validateSecretFolderSegment(value: string): string | null {
  if (!value.trim()) return "Folder name is required.";
  if (value.includes("/")) return "Folder name cannot contain slashes.";
  return null;
}
