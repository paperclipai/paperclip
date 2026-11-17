import { useContext, useState } from "react";
import { MediaArtifactCard } from "@/components/artifacts/MediaArtifactCard";
import { ImageGalleryModal } from "@/components/ImageGalleryModal";
import { IssueGalleryContext } from "@/context/IssueGalleryContext";
import { RichWorkProductCard } from "./RichWorkProductCard";
import { imageResourceSource } from "./image-resources";
import type { TaskChatMaterializedResourceItem } from "./task-chat-model";

export function TaskChatImageGrid({ items }: { items: TaskChatMaterializedResourceItem[] }) {
  const openIssueGallery = useContext(IssueGalleryContext);
  const [selected, setSelected] = useState<number | null>(null);
  const images = items.flatMap((item) => {
    const source = imageResourceSource(item);
    return source ? [{ item, source }] : [];
  });
  return (
    <IssueGalleryContext.Provider value={(src) => {
      if (openIssueGallery?.(src)) return true;
      const index = images.findIndex(({ source }) => source.contentPath === src || source.openPath === src);
      if (index < 0) return false;
      setSelected(index);
      return true;
    }}>
      <div className="tc-image-grid" role="group" aria-label={`${images.length} ${images.length === 1 ? "image" : "images"}`} data-testid="task-chat-image-grid">
        {images.map(({ item, source }) => (
          <div key={item.id} className="min-w-0" data-thread-anchor={item.id}>
            {item.workProduct ? <RichWorkProductCard workProduct={item.workProduct} href={item.href} variant="gallery" /> : <MediaArtifactCard id={source.id} title={item.title} contentPath={source.contentPath}
              contentType={source.contentType} originalFilename={source.filename} downloadPath={source.downloadPath} />}
          </div>
        ))}
      </div>
      {selected !== null && selected >= 0 ? (
        <ImageGalleryModal items={images.map(({ source }) => ({ ...source, originalFilename: source.filename }))}
          initialIndex={selected} open onOpenChange={(open) => { if (!open) setSelected(null); }} />
      ) : null}
    </IssueGalleryContext.Provider>
  );
}
