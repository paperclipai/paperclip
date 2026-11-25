import type {
  CompanyPortabilityEmbeddedAssetManifestEntry,
  CompanyPortabilityIssueManifestEntry,
} from "@paperclipai/shared";

/**
 * Export selection is category-driven: instead of per-file checkboxes the
 * export page exposes a small set of toggles, and the checked-file set is
 * derived from them. Root-level files (README.md, COMPANY.md,
 * .paperclip.yaml, images, company logo) always export and have no toggle.
 */
export type ExportCategoryKey =
  | "agents"
  | "projects"
  | "skills"
  | "routines"
  | "tasks"
  | "attachments";

export type ExportCategorySelection = Record<ExportCategoryKey, boolean>;

export type ExportSelectionIssue = Pick<
  CompanyPortabilityIssueManifestEntry,
  "path" | "recurring" | "attachments"
>;

export type ExportSelectionEmbeddedAsset = Pick<
  CompanyPortabilityEmbeddedAssetManifestEntry,
  "sha256" | "ownedBy"
>;

export const EXPORT_CATEGORY_ORDER: ExportCategoryKey[] = [
  "agents",
  "projects",
  "skills",
  "routines",
  "tasks",
  "attachments",
];

export const EXPORT_CATEGORY_LABELS: Record<ExportCategoryKey, string> = {
  agents: "Agents",
  projects: "Projects",
  skills: "Skills",
  routines: "Routines",
  tasks: "Tasks",
  attachments: "Attachments",
};

/** Everything exports by default. */
export function buildDefaultExportCategorySelection(): ExportCategorySelection {
  return {
    agents: true,
    projects: true,
    skills: true,
    routines: true,
    tasks: true,
    attachments: true,
  };
}

/**
 * Attachment blobs only travel with the task (or routine) that references
 * them — a blob without its owning task is an orphan the importer cannot
 * attach. The Attachments toggle is therefore only meaningful while at
 * least one of Tasks or Routines is still selected. Routines count because
 * the bundle schema lets a recurring task manifest entry carry attachments
 * (e.g. bundles that were imported and re-exported), even though natively
 * exported routines emit only their TASK.md.
 */
export function isAttachmentsCategoryEnabled(
  categories: Pick<ExportCategorySelection, "tasks" | "routines">,
): boolean {
  return categories.tasks || categories.routines;
}

function buildRecurringTaskPrefixes(issues: ExportSelectionIssue[]): Set<string> {
  const prefixes = new Set<string>();

  for (const issue of issues) {
    if (!issue.recurring) continue;

    const filePath = issue.path.trim();
    if (!filePath) continue;

    prefixes.add(filePath);

    const lastSlash = filePath.lastIndexOf("/");
    if (lastSlash >= 0) {
      prefixes.add(`${filePath.slice(0, lastSlash + 1)}`);
    }
  }

  return prefixes;
}

function isRecurringTaskFile(filePath: string, recurringTaskPrefixes: Set<string>): boolean {
  for (const prefix of recurringTaskPrefixes) {
    if (filePath === prefix || filePath.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Map each attachment blob sha to the kind of task that references it, so
 * blob inclusion can follow its owning task's toggle.
 */
function buildAttachmentShaOwnership(issues: ExportSelectionIssue[]): {
  recurring: Set<string>;
  oneOff: Set<string>;
} {
  const recurring = new Set<string>();
  const oneOff = new Set<string>();

  for (const issue of issues) {
    for (const attachment of issue.attachments ?? []) {
      const sha = attachment.sha256.trim().toLowerCase();
      if (!sha) continue;
      (issue.recurring ? recurring : oneOff).add(sha);
    }
  }

  return { recurring, oneOff };
}

const EMBEDDED_ASSET_OWNER_CATEGORY_KEYS = new Set<ExportCategoryKey>([
  "agents",
  "projects",
  "skills",
  "routines",
  "tasks",
]);

/**
 * Map each embedded-asset blob sha to the export categories whose files
 * reference it (from the manifest's embeddedAssets ownedBy field). Multiple
 * asset entries can share one content-addressed blob; ownership unions.
 * Entries without ownership data count as always included.
 */
function buildEmbeddedAssetShaOwnership(
  embeddedAssets: ExportSelectionEmbeddedAsset[],
): Map<string, Set<string>> {
  const ownersBySha = new Map<string, Set<string>>();
  for (const entry of embeddedAssets) {
    const sha = entry.sha256.trim().toLowerCase();
    if (!sha) continue;
    const owners = ownersBySha.get(sha) ?? new Set<string>();
    const ownedBy = entry.ownedBy && entry.ownedBy.length > 0 ? entry.ownedBy : ["always"];
    for (const owner of ownedBy) owners.add(owner);
    ownersBySha.set(sha, owners);
  }
  return ownersBySha;
}

/**
 * An embedded-asset blob follows the toggles of the files that reference it,
 * independent of the Attachments toggle: it stays while any owning category
 * is still selected. "always" owners (root-file references) and owners this
 * build does not recognize keep the bytes rather than silently dropping them.
 */
function isEmbeddedAssetBlobIncluded(
  owners: Set<string>,
  categories: ExportCategorySelection,
): boolean {
  for (const owner of owners) {
    if (!EMBEDDED_ASSET_OWNER_CATEGORY_KEYS.has(owner as ExportCategoryKey)) return true;
    if (categories[owner as ExportCategoryKey]) return true;
  }
  return false;
}

/**
 * Classify a bundle file path into its export category, or null for
 * root-level files that always export (README.md, COMPANY.md,
 * .paperclip.yaml, images, company logo).
 */
export function categorizeExportFile(
  filePath: string,
  recurringTaskPrefixes: Set<string>,
): ExportCategoryKey | null {
  if (filePath.startsWith("agents/")) return "agents";
  if (filePath.startsWith("projects/")) return "projects";
  if (filePath.startsWith("skills/")) return "skills";
  if (filePath.startsWith("tasks/")) {
    return isRecurringTaskFile(filePath, recurringTaskPrefixes) ? "routines" : "tasks";
  }
  if (filePath.startsWith("blobs/")) return "attachments";
  return null;
}

/** Count bundle files per category (root always-exported files are not counted). */
export function countExportFilesByCategory(
  filePaths: string[],
  issues: ExportSelectionIssue[],
): Record<ExportCategoryKey, number> {
  const recurringTaskPrefixes = buildRecurringTaskPrefixes(issues);
  const counts: Record<ExportCategoryKey, number> = {
    agents: 0,
    projects: 0,
    skills: 0,
    routines: 0,
    tasks: 0,
    attachments: 0,
  };
  for (const filePath of filePaths) {
    const category = categorizeExportFile(filePath, recurringTaskPrefixes);
    if (category) counts[category] += 1;
  }
  return counts;
}

/**
 * Compute the set of files the export will include for the given category
 * selection. Pure: same inputs, same set. The Tasks/Routines → Attachments
 * dependency is enforced here, so callers cannot produce orphan blobs even
 * with an inconsistent selection.
 */
export function buildExportCheckedFiles(input: {
  filePaths: string[];
  issues: ExportSelectionIssue[];
  categories: ExportCategorySelection;
  embeddedAssets?: ExportSelectionEmbeddedAsset[];
}): Set<string> {
  const { filePaths, issues, categories } = input;
  const recurringTaskPrefixes = buildRecurringTaskPrefixes(issues);
  const blobOwnership = buildAttachmentShaOwnership(issues);
  const embeddedOwnership = buildEmbeddedAssetShaOwnership(input.embeddedAssets ?? []);
  const attachmentsOn = categories.attachments && isAttachmentsCategoryEnabled(categories);

  const checked = new Set<string>();
  for (const filePath of filePaths) {
    const category = categorizeExportFile(filePath, recurringTaskPrefixes);

    if (category === null) {
      // Root files always export.
      checked.add(filePath);
      continue;
    }

    if (category === "attachments") {
      const sha = filePath.slice("blobs/".length).trim().toLowerCase();
      // Embedded-asset blobs travel with the files that reference them,
      // regardless of the Attachments toggle. A blob shared with an
      // attachment can still qualify through the attachment path below.
      const embeddedOwners = embeddedOwnership.get(sha);
      if (embeddedOwners && isEmbeddedAssetBlobIncluded(embeddedOwners, categories)) {
        checked.add(filePath);
        continue;
      }
      if (!attachmentsOn) continue;
      const ownedByRecurring = blobOwnership.recurring.has(sha);
      const ownedByOneOff = blobOwnership.oneOff.has(sha);
      if (!ownedByRecurring && !ownedByOneOff) {
        // Unreferenced blob: no owning task or embedded reference to
        // follow, gate on the attachments toggle alone (already dependent
        // on tasks/routines). Embedded-owned blobs whose owners are all
        // disabled stay dropped instead of falling back to this gate.
        if (!embeddedOwners) checked.add(filePath);
      } else if (
        (ownedByOneOff && categories.tasks)
        || (ownedByRecurring && categories.routines)
      ) {
        checked.add(filePath);
      }
      continue;
    }

    if (categories[category]) checked.add(filePath);
  }

  return checked;
}
