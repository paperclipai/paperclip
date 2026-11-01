import type { DirectionKit } from "../../kit";
import { ThreadWorkProduct } from "./ThreadWorkProduct";
import { ThreadAttachments } from "./ThreadAttachments";
import { PanelBody } from "./PanelBody";
import { GalleryStack, GalleryStacks } from "./Gallery";

/** The control: the components that ship today, fed with the lab's fixtures. */
export const kit: DirectionKit = {
  id: "today",
  name: "0.Today",
  tagline: "What ships now — outlined cards on the page fill",
  ThreadWorkProduct,
  ThreadAttachments,
  PanelBody,
  GalleryStacks,
  GalleryStack,
};
