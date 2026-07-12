// @vitest-environment node

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ResponsibleUserDenialNotice } from "./ResponsibleUserDenialNotice";

describe("ResponsibleUserDenialNotice", () => {
  it("renders unauthorized copy that names the responsible user", () => {
    const html = renderToStaticMarkup(
      <ResponsibleUserDenialNotice
        code="RESPONSIBLE_USER_UNAUTHORIZED"
        userName="Ada Lovelace"
      />,
    );

    expect(html).toContain("Responsible user not authorized");
    expect(html).toContain("Ada Lovelace");
    expect(html).toContain('data-denial-code="RESPONSIBLE_USER_UNAUTHORIZED"');
    expect(html).toContain('data-denial-tone="unauthorized"');
  });

  it("renders unavailable copy steering toward marking work blocked", () => {
    const html = renderToStaticMarkup(
      <ResponsibleUserDenialNotice
        code="RESPONSIBLE_USER_UNAVAILABLE"
        userName="Grace Hopper"
      />,
    );

    expect(html).toContain("Responsible user unavailable");
    expect(html).toContain("Grace Hopper");
    expect(html).toContain('data-denial-tone="unavailable"');
    expect(html.toLowerCase()).toContain("blocked");
  });

  it("falls back to generic phrasing when the user name is unknown", () => {
    const html = renderToStaticMarkup(
      <ResponsibleUserDenialNotice code="RESPONSIBLE_USER_UNAUTHORIZED" />,
    );
    expect(html).toContain("the responsible user");
  });

  it("never uses the word impersonate", () => {
    const html = renderToStaticMarkup(
      <ResponsibleUserDenialNotice
        code="RESPONSIBLE_USER_UNAVAILABLE"
        userName="Someone"
      />,
    );
    expect(html.toLowerCase()).not.toContain("impersonate");
  });
});
