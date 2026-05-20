import { Suspense, lazy } from "react";
import { useDialogState } from "@/context/DialogContext";

// LET-506 — mount the legacy `NewIssueDialog` inside `EaosProductLayout`
// only after the user has triggered it. The dialog itself imports a
// heavy MDX editor + sandpack pipeline at module init that fails to
// initialize under jsdom (Stitches CSS parse error), so a static import
// would explode the EAOS layout test suite. `React.lazy` defers the
// import until `newIssueOpen` flips, matching Multica's modal-lazy
// pattern and keeping the EAOS shell read-only by default.
const NewIssueDialog = lazy(() =>
  import("@/components/NewIssueDialog").then((mod) => ({ default: mod.NewIssueDialog })),
);

export function LazyNewIssueDialog() {
  const { newIssueOpen } = useDialogState();
  if (!newIssueOpen) return null;
  return (
    <Suspense fallback={null}>
      <NewIssueDialog />
    </Suspense>
  );
}
