// The "Store as secret" (convert) flow shares its form with the create flow;
// both live in CreateSecretPopover.tsx. Re-exported here so the module keeps a
// dedicated entry point for the convert popover (plan §4 file list).
export { ConvertToSecretPopover } from "./CreateSecretPopover";
