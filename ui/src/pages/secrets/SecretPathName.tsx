import { cn } from "@/lib/utils";
import { splitSecretPath } from "./secret-path";

interface SecretPathNameProps {
  /** Full stored secret name, e.g. `dev/github/oauth/clientid`. */
  name: string;
  /**
   * Folder path currently being viewed. Segments shared with `name` are
   * stripped so folder-view rows show only the part below the open folder.
   * Omit (or leave empty) to render the full path — used for global search
   * results and the My secrets tab.
   */
  basePath?: string;
  className?: string;
  /** Extra classes for the bold leaf segment. */
  leafClassName?: string;
}

/**
 * Renders a slash-delimited secret name with the directory portion muted and
 * the trailing leaf bold. Shared across folder-view rows, global search
 * results, and (rendering only) the My secrets tab so paths read the same way
 * everywhere. See PAP-14698 plan §Search.
 */
export function SecretPathName({ name, basePath = "", className, leafClassName }: SecretPathNameProps) {
  const segments = splitSecretPath(name);
  const baseSegments = splitSecretPath(basePath);
  const withinBase =
    baseSegments.length > 0 &&
    baseSegments.every((segment, index) => segments[index] === segment) &&
    segments.length > baseSegments.length;
  const relative = withinBase ? segments.slice(baseSegments.length) : segments;
  const effective = relative.length > 0 ? relative : [name];
  const leaf = effective[effective.length - 1];
  const directory = effective.slice(0, -1).join("/");

  return (
    <span className={cn("min-w-0 truncate", className)}>
      {directory ? <span className="text-muted-foreground">{directory}/</span> : null}
      <span className={cn("font-medium text-foreground", leafClassName)}>{leaf}</span>
    </span>
  );
}
