import { useCallback, useEffect, useRef, useState, type ComponentProps } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { buildDocumentAnnotationHash, parseDocumentAnnotationHash } from "@/lib/document-annotation-hash";
import { ImageGalleryModal, type GalleryMediaItem } from "./ImageGalleryModal";
import { MarkdownBody } from "./MarkdownBody";

type DocumentMarkdownBodyProps = Omit<ComponentProps<typeof MarkdownBody>, "onImageClick"> & {
  documentKey: string;
  revisionId?: string;
  documentIssueId?: string;
  currentIssueId?: string;
};

export function DocumentMarkdownBody({ documentKey, revisionId, documentIssueId, currentIssueId, ...props }: DocumentMarkdownBodyProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const locationRef = useRef(location);
  locationRef.current = location;
  const containerRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLImageElement | null>(null);
  const [items, setItems] = useState<GalleryMediaItem[]>([]);
  const target = parseDocumentAnnotationHash(location.hash);
  const matchesDocument = target?.documentKey === documentKey
    && target.revisionId === revisionId
    && (target.documentIssueId ?? currentIssueId) === (documentIssueId ?? currentIssueId);
  const image = matchesDocument ? target.image : undefined;

  const readImages = useCallback(() =>
    Array.from(containerRef.current?.querySelectorAll<HTMLImageElement>(".paperclip-markdown img[src]") ?? [])
      .filter((element) => Boolean(element.getAttribute("src"))), []);

  useEffect(() => {
    if (!image) return;
    const images = readImages();
    setItems(images.map((element, index) => ({
      id: String(index),
      contentPath: element.getAttribute("src")!,
      downloadPath: element.getAttribute("src")!,
      contentType: "image/*",
      originalFilename: element.alt || `Image ${index + 1}`,
    })));
    if (!returnFocusRef.current?.isConnected) returnFocusRef.current = images[image - 1] ?? null;
  }, [image, props.children, readImages]);

  const updateImage = useCallback((index?: number) => {
    const location = locationRef.current;
    const current = parseDocumentAnnotationHash(location.hash);
    const sameDocument = current?.documentKey === documentKey
      && current.revisionId === revisionId
      && (current.documentIssueId ?? currentIssueId) === (documentIssueId ?? currentIssueId);
    const hash = buildDocumentAnnotationHash({
      ...(sameDocument ? current : { documentKey, threadId: null, commentId: null }),
      revisionId,
      documentIssueId: sameDocument ? current.documentIssueId : documentIssueId,
      image: index === undefined ? undefined : index + 1,
    });
    navigate({ pathname: location.pathname, search: location.search, hash }, { replace: true, state: location.state });
  }, [currentIssueId, documentIssueId, documentKey, navigate, revisionId]);

  const openImage = useCallback((_src: string, element: HTMLImageElement) => {
    const index = readImages().indexOf(element);
    if (index < 0) return;
    returnFocusRef.current = element;
    updateImage(index);
  }, [readImages, updateImage]);

  return (
    <div ref={containerRef}>
      <MarkdownBody {...props} onImageClick={openImage} />
      <ImageGalleryModal
        items={items}
        initialIndex={(image ?? 1) - 1}
        open={Boolean(image && image <= items.length)}
        onIndexChange={updateImage}
        onOpenChange={(open) => { if (!open) updateImage(); }}
        returnFocusRef={returnFocusRef}
      />
    </div>
  );
}
