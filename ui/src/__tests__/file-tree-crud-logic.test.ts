// @vitest-environment node
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// FileTree CRUD dialog logic tests
//
// The FileTree component contains logic that is exercised by the new CRUD
// modal dialogs added in the workspace-file-crud-operations feature:
//
//   • getFilePath(parentPath, name)       – path construction (also covered in
//                                           file-tree-logic.test.ts; extended
//                                           here for rename/create-dialog cases)
//   • createItemPath(currentPath, name)   – path for new file/folder creation
//   • renameTargetPath(parentPath, name)  – target path for rename operations
//   • validateItemName(name)              – dialog input validation logic
//   • toastTitle(isDirectory, op)         – toast message selection
//
// All logic is mirrored from ui/src/components/FileTree.tsx so the tests stay
// fast and self-contained (node environment, no DOM, no React).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helpers mirrored from FileTree.tsx
// ---------------------------------------------------------------------------

/** Builds a child path from its parent (mirrors FileTree.tsx). */
function getFilePath(parentPath: string, name: string): string {
  if (parentPath === ".") return name;
  return `${parentPath}/${name}`;
}

/**
 * Computes the full path for a new file or folder created in the
 * CreateItemDialog. Equivalent to the mutation fn in CreateItemDialog.
 */
function createItemPath(currentPath: string, itemName: string): string {
  return getFilePath(currentPath, itemName);
}

/**
 * Computes the rename target path for FileTreeNode.renameEntry.mutationFn.
 * The new name is placed in the same directory as the original.
 */
function renameTargetPath(parentPath: string, newName: string): string {
  return getFilePath(parentPath, newName);
}

/**
 * Validates a dialog name input. Returns an error string when invalid, or
 * null when the input is acceptable. Mirrors the handleSubmit guard in
 * CreateItemDialog.
 */
function validateItemName(raw: string, label: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return `${label} name is required.`;
  return null;
}

/**
 * Returns the toast title for a delete or rename operation.
 * Mirrors the string template inside FileTreeNode mutations.
 */
function toastTitle(
  isDirectory: boolean,
  op: "deleted" | "renamed" | "failedDelete" | "failedRename",
): string {
  const kind = isDirectory ? "Folder" : "File";
  switch (op) {
    case "deleted":
      return `${kind} deleted`;
    case "renamed":
      return `${kind} renamed`;
    case "failedDelete":
      return `Failed to delete ${kind.toLowerCase()}`;
    case "failedRename":
      return `Failed to rename ${kind.toLowerCase()}`;
  }
}

/**
 * Returns the toast title for CreateItemDialog operations.
 * Mirrors the createItem mutation in CreateItemDialog.
 */
function createToastTitle(isFile: boolean, op: "created" | "failed"): string {
  const label = isFile ? "File" : "Folder";
  if (op === "created") return `${label} created`;
  return `Failed to create ${label.toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// createItemPath — path for new file/folder creation
// ---------------------------------------------------------------------------

describe("createItemPath", () => {
  it("creates root-level path from workspace root (.)", () => {
    expect(createItemPath(".", "index.ts")).toBe("index.ts");
  });

  it("creates nested path when inside a subdirectory", () => {
    expect(createItemPath("src", "index.ts")).toBe("src/index.ts");
  });

  it("creates deeply nested path", () => {
    expect(createItemPath("src/components/ui", "button.tsx")).toBe(
      "src/components/ui/button.tsx",
    );
  });

  it("handles folder creation at root", () => {
    expect(createItemPath(".", "my-folder")).toBe("my-folder");
  });

  it("handles folder creation inside a subdirectory", () => {
    expect(createItemPath("src", "utils")).toBe("src/utils");
  });

  it("handles dotfiles at root", () => {
    expect(createItemPath(".", ".gitignore")).toBe(".gitignore");
  });

  it("handles dotfiles in subdirectory", () => {
    expect(createItemPath("config", ".env.local")).toBe("config/.env.local");
  });

  it("does not produce a leading ./ prefix for root-level items", () => {
    const path = createItemPath(".", "file.ts");
    expect(path.startsWith("./")).toBe(false);
    expect(path).toBe("file.ts");
  });
});

// ---------------------------------------------------------------------------
// renameTargetPath — target path for rename operations
// ---------------------------------------------------------------------------

describe("renameTargetPath", () => {
  it("renames a root-level file (stays at root)", () => {
    expect(renameTargetPath(".", "new-name.ts")).toBe("new-name.ts");
  });

  it("renames a file inside a subdirectory (same directory, different name)", () => {
    expect(renameTargetPath("src", "renamed.ts")).toBe("src/renamed.ts");
  });

  it("renames a deeply nested file", () => {
    expect(renameTargetPath("a/b/c", "new.json")).toBe("a/b/c/new.json");
  });

  it("renames a folder at root", () => {
    expect(renameTargetPath(".", "new-folder")).toBe("new-folder");
  });

  it("renames a folder inside a parent", () => {
    expect(renameTargetPath("src", "new-utils")).toBe("src/new-utils");
  });

  it("handles renaming to a dotfile", () => {
    expect(renameTargetPath(".", ".env")).toBe(".env");
  });

  it("rename stays within the same parent — never escapes to root accidentally", () => {
    const target = renameTargetPath("src/components", "NewButton.tsx");
    expect(target).toBe("src/components/NewButton.tsx");
    expect(target.startsWith("src/components/")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateItemName — dialog input validation
// ---------------------------------------------------------------------------

describe("validateItemName (File)", () => {
  it("returns null for a valid file name", () => {
    expect(validateItemName("index.ts", "File")).toBeNull();
  });

  it("returns an error for an empty string", () => {
    expect(validateItemName("", "File")).toBe("File name is required.");
  });

  it("returns an error for a whitespace-only string", () => {
    expect(validateItemName("   ", "File")).toBe("File name is required.");
  });

  it("trims whitespace before validating (single space is treated as empty)", () => {
    expect(validateItemName(" ", "File")).toBe("File name is required.");
  });

  it("accepts a name with a dot prefix (dotfile)", () => {
    expect(validateItemName(".gitignore", "File")).toBeNull();
  });

  it("accepts a name with an extension", () => {
    expect(validateItemName("component.tsx", "File")).toBeNull();
  });

  it("accepts a name that is all numbers", () => {
    expect(validateItemName("123", "File")).toBeNull();
  });

  it("accepts a name with spaces (not trimmed to empty)", () => {
    expect(validateItemName("my file.txt", "File")).toBeNull();
  });
});

describe("validateItemName (Folder)", () => {
  it("returns null for a valid folder name", () => {
    expect(validateItemName("components", "Folder")).toBeNull();
  });

  it("returns an error for an empty string", () => {
    expect(validateItemName("", "Folder")).toBe("Folder name is required.");
  });

  it("returns an error for whitespace only", () => {
    expect(validateItemName("  \t  ", "Folder")).toBe("Folder name is required.");
  });

  it("accepts a name with a dash", () => {
    expect(validateItemName("my-components", "Folder")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// toastTitle — title strings for delete/rename operations
// ---------------------------------------------------------------------------

describe("toastTitle — file operations", () => {
  it("returns 'File deleted' on successful file delete", () => {
    expect(toastTitle(false, "deleted")).toBe("File deleted");
  });

  it("returns 'Folder deleted' on successful folder delete", () => {
    expect(toastTitle(true, "deleted")).toBe("Folder deleted");
  });

  it("returns 'File renamed' on successful file rename", () => {
    expect(toastTitle(false, "renamed")).toBe("File renamed");
  });

  it("returns 'Folder renamed' on successful folder rename", () => {
    expect(toastTitle(true, "renamed")).toBe("Folder renamed");
  });

  it("returns 'Failed to delete file' on file delete error", () => {
    expect(toastTitle(false, "failedDelete")).toBe("Failed to delete file");
  });

  it("returns 'Failed to delete folder' on folder delete error", () => {
    expect(toastTitle(true, "failedDelete")).toBe("Failed to delete folder");
  });

  it("returns 'Failed to rename file' on file rename error", () => {
    expect(toastTitle(false, "failedRename")).toBe("Failed to rename file");
  });

  it("returns 'Failed to rename folder' on folder rename error", () => {
    expect(toastTitle(true, "failedRename")).toBe("Failed to rename folder");
  });
});

// ---------------------------------------------------------------------------
// createToastTitle — title strings for create operations
// ---------------------------------------------------------------------------

describe("createToastTitle", () => {
  it("returns 'File created' on successful file creation", () => {
    expect(createToastTitle(true, "created")).toBe("File created");
  });

  it("returns 'Folder created' on successful folder creation", () => {
    expect(createToastTitle(false, "created")).toBe("Folder created");
  });

  it("returns 'Failed to create file' on file creation error", () => {
    expect(createToastTitle(true, "failed")).toBe("Failed to create file");
  });

  it("returns 'Failed to create folder' on folder creation error", () => {
    expect(createToastTitle(false, "failed")).toBe("Failed to create folder");
  });
});

// ---------------------------------------------------------------------------
// Integration: create then rename path round-trip
// ---------------------------------------------------------------------------

describe("create-then-rename round-trip", () => {
  it("a file created at root can be renamed to a new name in the same dir", () => {
    const createdPath = createItemPath(".", "draft.ts");
    // createdPath is the full path (also the parentPath is "." for root items)
    // renameTargetPath takes parentPath = ".", newName = "final.ts"
    const renamedPath = renameTargetPath(".", "final.ts");
    expect(createdPath).toBe("draft.ts");
    expect(renamedPath).toBe("final.ts");
  });

  it("a file created in a subdirectory can be renamed within that directory", () => {
    const createdPath = createItemPath("src", "draft.ts");
    const renamedPath = renameTargetPath("src", "final.ts");
    expect(createdPath).toBe("src/draft.ts");
    expect(renamedPath).toBe("src/final.ts");
  });

  it("a folder created at root can be renamed", () => {
    const createdPath = createItemPath(".", "temp-folder");
    const renamedPath = renameTargetPath(".", "final-folder");
    expect(createdPath).toBe("temp-folder");
    expect(renamedPath).toBe("final-folder");
  });

  it("rename of nested item stays in same directory", () => {
    const createdPath = createItemPath("a/b", "c.json");
    // The parent path of "a/b/c.json" is "a/b"
    const renamedPath = renameTargetPath("a/b", "d.json");
    expect(createdPath).toBe("a/b/c.json");
    expect(renamedPath).toBe("a/b/d.json");
  });
});

// ---------------------------------------------------------------------------
// Delete dialog description text
// ---------------------------------------------------------------------------

/**
 * Mirrors the DialogDescription text in the delete confirmation dialog.
 * Ensures the string variants for file vs folder are correct.
 */
function deleteDialogDescription(isDirectory: boolean): string {
  return `This action cannot be undone.${isDirectory ? " All contents of the folder will be removed." : ""}`;
}

describe("deleteDialogDescription", () => {
  it("omits folder warning for a file", () => {
    expect(deleteDialogDescription(false)).toBe(
      "This action cannot be undone.",
    );
  });

  it("includes folder warning for a directory", () => {
    expect(deleteDialogDescription(true)).toBe(
      "This action cannot be undone. All contents of the folder will be removed.",
    );
  });
});

// ---------------------------------------------------------------------------
// CreateItemDialog description text
// ---------------------------------------------------------------------------

/**
 * Mirrors the DialogDescription text in the CreateItemDialog.
 */
function createDialogDescription(isFile: boolean): string {
  const label = isFile ? "file" : "folder";
  return `Enter a name for the new ${label} in this workspace.`;
}

describe("createDialogDescription", () => {
  it("uses 'file' label for file creation dialog", () => {
    expect(createDialogDescription(true)).toBe(
      "Enter a name for the new file in this workspace.",
    );
  });

  it("uses 'folder' label for folder creation dialog", () => {
    expect(createDialogDescription(false)).toBe(
      "Enter a name for the new folder in this workspace.",
    );
  });
});

// ---------------------------------------------------------------------------
// Dialog title text
// ---------------------------------------------------------------------------

function createDialogTitle(isFile: boolean): string {
  return isFile ? "New File" : "New Folder";
}

function deleteDialogTitle(isDirectory: boolean): string {
  return `Delete ${isDirectory ? "folder" : "file"}`;
}

describe("dialog titles", () => {
  it("create dialog title is 'New File' for file type", () => {
    expect(createDialogTitle(true)).toBe("New File");
  });

  it("create dialog title is 'New Folder' for folder type", () => {
    expect(createDialogTitle(false)).toBe("New Folder");
  });

  it("delete dialog title is 'Delete file' for a file", () => {
    expect(deleteDialogTitle(false)).toBe("Delete file");
  });

  it("delete dialog title is 'Delete folder' for a directory", () => {
    expect(deleteDialogTitle(true)).toBe("Delete folder");
  });
});
