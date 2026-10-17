import { describe, expect, it } from "vitest";
import { parseHttpRepoUrl } from "./repo-url.js";

describe("parseHttpRepoUrl", () => {
  it.each([
    "https://github.com/paperclipai/paperclip.git",
    "http://git.internal/group/repo",
    "  https://bot@gitlab.com/group/repo.git  ",
  ])("accepts %j", (raw) => {
    expect(parseHttpRepoUrl(raw)).toBeInstanceOf(URL);
  });

  it.each([
    "",
    "https://",
    "https://github.com",
    "https://github.com/",
    "git@github.com:paperclipai/paperclip.git",
    "ssh://git@github.com/paperclipai/paperclip.git",
    "file:///tmp/repo",
    "not a url",
  ])("rejects %j", (raw) => {
    expect(parseHttpRepoUrl(raw)).toBeNull();
  });
});
