import {
  LinkNode,
  type LinkAttributes,
  type SerializedLinkNode,
} from "@lexical/link";

const CUSTOM_MENTION_URL_RE = /^(agent|project|skill):\/\//;

export class MentionAwareLinkNode extends LinkNode {
  static getType(): string {
    return "mention-aware-link";
  }

  static clone(node: MentionAwareLinkNode): MentionAwareLinkNode {
    return new MentionAwareLinkNode(
      node.getURL(),
      {
        rel: node.getRel(),
        target: node.getTarget(),
        title: node.getTitle(),
      },
      node.getKey(),
    );
  }

  static importJSON(serializedNode: SerializedLinkNode): MentionAwareLinkNode {
    return new MentionAwareLinkNode(
      serializedNode.url ?? "",
      {
        rel: serializedNode.rel ?? null,
        target: serializedNode.target ?? null,
        title: serializedNode.title ?? null,
      },
    );
  }

  constructor(url?: string, attributes?: LinkAttributes, key?: string) {
    super(url, attributes, key);
  }

  sanitizeUrl(url: string): string {
    if (CUSTOM_MENTION_URL_RE.test(url)) return url;
    return super.sanitizeUrl(url);
  }
}

type MentionAwareLinkSource = Pick<LinkNode, "getURL" | "getRel" | "getTarget" | "getTitle">;

export function getMentionAwareLinkNodeInit(node: MentionAwareLinkSource) {
  return {
    url: node.getURL(),
    attributes: {
      rel: node.getRel(),
      target: node.getTarget(),
      title: node.getTitle(),
    },
  };
}

export const mentionAwareLinkNodeReplacement = {
  replace: LinkNode,
  with: (node: LinkNode) => {
    const { url, attributes } = getMentionAwareLinkNodeInit(node);
    return new MentionAwareLinkNode(url, attributes);
  },
  withKlass: MentionAwareLinkNode,
} as const;
