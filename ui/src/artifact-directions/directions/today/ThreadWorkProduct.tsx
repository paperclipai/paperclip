import { TaskChatProtocolCard } from "@/components/task-chat/TaskChatProtocolCard";
import { RichWorkProductCard } from "@/components/task-chat/RichWorkProductCard";
import { workProductHref } from "@/lib/issue-artifacts";
import type { LabArtifact } from "../../kit";
import { documentHref, isTaskDocument, toWorkProduct } from "./adapters";

/**
 * The two shipped thread rows: the generic resource card for a task document
 * ("Document · rev N", TaskChatProtocolCard.tsx:1016-1049) and the rich
 * work-product row for everything an agent registered (RichWorkProductCard).
 * The split and the subtitle are TaskChatThread.tsx:1271-1320.
 */
export function ThreadWorkProduct({ artifact }: { artifact: LabArtifact }) {
  if (isTaskDocument(artifact)) {
    return (
      <TaskChatProtocolCard
        item={{
          id: `resource:${artifact.id}`,
          kind: "protocol",
          surface: "resource",
          resourceKind: "document",
          title: artifact.title,
          subtitle: `Document · rev ${artifact.revision}`,
          href: documentHref(artifact),
        }}
      />
    );
  }
  const workProduct = toWorkProduct(artifact);
  return <RichWorkProductCard workProduct={workProduct} href={workProductHref(workProduct)} />;
}
