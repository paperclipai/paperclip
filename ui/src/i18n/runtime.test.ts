// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  getRuntimeLocale,
  readStoredLocalePreference,
  writeStoredLocalePreference,
} from "./runtime";

describe("i18n runtime", () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it("prefers the messenger language key when present", () => {
    window.localStorage.setItem("hublit-ui-lang", "ja");
    window.localStorage.setItem("paperclip.locale", "ko");

    expect(readStoredLocalePreference()).toBe("ja");
  });

  it("writes both paperclip and messenger locale keys for sync", () => {
    writeStoredLocalePreference("ko");

    expect(window.localStorage.getItem("paperclip.locale")).toBe("ko");
    expect(window.localStorage.getItem("hublit-ui-lang")).toBe("ko");
  });

  it("returns english when no browser or stored preference exists", () => {
    expect(getRuntimeLocale()).toBe("en");
  });
});
