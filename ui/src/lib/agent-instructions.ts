export function instructionsBundleHasFile(input: {
  bundleMatchesDraft: boolean;
  currentEntryFile: string;
  selectedFile: string;
  fileOptions: string[];
}): boolean {
  if (!input.bundleMatchesDraft) return false;
  if (input.selectedFile === input.currentEntryFile) return true;
  return input.fileOptions.includes(input.selectedFile);
}
