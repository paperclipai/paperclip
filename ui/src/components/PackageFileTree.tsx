import { FileTree } from "./FileTree";
import type { FileTreeProps } from "./FileTree";

export function PackageFileTree({ wrapLabels = false, ...props }: FileTreeProps) {
  return <FileTree {...props} wrapLabels={wrapLabels} />;
}

export {
  FRONTMATTER_FIELD_LABELS,
  buildFileTree,
  collectAllPaths,
  countFiles,
  parseFrontmatter,
} from "./FileTree";
export type {
  FileTreeBadge,
  FileTreeBadgeVariant,
  FileTreeEmptyState,
  FileTreeErrorState,
  FileTreeNode,
  FileTreeProps,
  FileTreeTone,
  FrontmatterData,
} from "./FileTree";
