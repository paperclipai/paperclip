import { useEffect } from "react";

const APP_NAME = "Paperclip";

export interface PageMetaOg {
  /** og:type — defaults to "website" */
  type?: string;
  /** og:url — the canonical URL of the page */
  url?: string;
  /** og:image — a URL to an image for social cards */
  image?: string;
  /** og:image:alt — alt text for the image */
  imageAlt?: string;
}

/**
 * Set the page title, meta description, and optional Open Graph / Twitter
 * Card tags in `<head>`.
 *
 * Call this at the top level of every page component. Child routes override
 * parent meta — the last call in the tree wins because React bottoms-out
 * effects in insertion order and runs the deepest effect last.
 *
 * @param title - Page-specific title (e.g. "Dashboard"). Appended with
 *   " — Paperclip" automatically. Pass empty string for the bare app name.
 * @param description - Optional meta description.
 * @param og - Optional Open Graph / Twitter Card configuration.
 */
export function usePageMeta(
  title: string,
  description?: string,
  og?: PageMetaOg,
): void {
  useEffect(() => {
    const fullTitle = title ? `${title} — ${APP_NAME}` : APP_NAME;
    const prevTitle = document.title;
    document.title = fullTitle;

    // Manage <meta name="description">
    const META_SELECTOR = 'meta[name="description"]';
    let metaEl = document.querySelector<HTMLMetaElement>(META_SELECTOR);

    if (description && description.length > 0) {
      if (metaEl) {
        metaEl.setAttribute("content", description);
      } else {
        metaEl = document.createElement("meta");
        metaEl.name = "description";
        metaEl.content = description;
        document.head.appendChild(metaEl);
      }
    } else if (metaEl) {
      metaEl.remove();
    }

    // Manage Open Graph and Twitter Card tags
    const ogTags: Array<{ property: string; content: string }> = [];

    if (title) {
      ogTags.push({ property: "og:title", content: fullTitle });
      ogTags.push({ property: "twitter:title", content: fullTitle });
    }
    if (description) {
      ogTags.push({ property: "og:description", content: description });
      ogTags.push({ property: "twitter:description", content: description });
    }
    ogTags.push({ property: "og:type", content: og?.type ?? "website" });
    ogTags.push({ property: "twitter:card", content: "summary" });
    if (og?.url) {
      ogTags.push({ property: "og:url", content: og.url });
    }
    if (og?.image) {
      ogTags.push({ property: "og:image", content: og.image });
      if (og?.imageAlt) {
        ogTags.push({ property: "og:image:alt", content: og.imageAlt });
      }
    }

    // Apply OG/Twitter meta tags
    const managedTags: HTMLMetaElement[] = [];
    for (const { property, content } of ogTags) {
      const selector = `meta[property="${property}"]`;
      let el = document.querySelector<HTMLMetaElement>(selector);
      if (el) {
        el.setAttribute("content", content);
      } else {
        el = document.createElement("meta");
        el.setAttribute("property", property);
        el.setAttribute("content", content);
        document.head.appendChild(el);
      }
      managedTags.push(el);
    }

    return () => {
      document.title = prevTitle;
      if (metaEl && document.head.contains(metaEl)) {
        const currentDescription = metaEl.getAttribute("content");
        if (currentDescription === description) {
          metaEl.remove();
        }
      }
      // Clean up OG/Twitter tags we created
      for (const tag of managedTags) {
        if (document.head.contains(tag)) {
          tag.remove();
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, description, og?.type, og?.url, og?.image, og?.imageAlt]);
}