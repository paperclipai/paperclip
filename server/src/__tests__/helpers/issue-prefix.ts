import { randomBytes } from "node:crypto";

export function uniqueIssuePrefix(tag: string) {
  return `${tag}${randomBytes(6).toString("hex").toUpperCase()}`;
}
