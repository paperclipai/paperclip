"""HTTP /endpoint handlers driven by the control plane.

Each handler takes (page, body) and returns either a JSON-serializable dict
or a (bytes, content_type) tuple. The control plane routes POSTs through
the ROUTES dict at the bottom of this file.

Note: `page.evaluate(...)` calls below are Playwright's in-browser JS
runner, not Python's `eval()` — they execute pre-vetted strings inside the
Webflow Designer's own DOM context, which is the entire point of the bot.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from . import page_ops

if TYPE_CHECKING:
    # Playwright imported only for type hints — keeps endpoints.py
    # importable in unit-test CI that skips the Docker layer.
    from playwright.sync_api import Page


def ep_screenshot(page: Page, body: dict) -> tuple[bytes, str]:
    full = bool(body.get("fullPage", False))
    img = page.screenshot(full_page=full, type="png")
    return img, "image/png"


def ep_eval(page: Page, body: dict) -> dict:
    """POST /eval — wraps caller JS in an async IIFE before page.evaluate.

    The eval endpoint is named for its in-browser equivalent (page.evaluate)
    — it runs JS inside the Webflow Designer's DOM, not Python code.
    """
    code = body.get("code", "")
    wrapped = "(async () => { " + code + " })()"
    return {"result": page.evaluate(wrapped)}


def ep_key(page: Page, body: dict) -> dict:
    page.keyboard.press(body["key"])
    return {"ok": True}


def ep_click(page: Page, body: dict) -> dict:
    page.mouse.click(int(body["x"]), int(body["y"]))
    return {"ok": True}


def ep_dblclick(page: Page, body: dict) -> dict:
    page.mouse.dblclick(int(body["x"]), int(body["y"]))
    return {"ok": True}


def ep_drag(page: Page, body: dict) -> dict:
    """Drag from (fromX, fromY) → (toX, toY) with intermediate steps so
    native HTML5 drag-and-drop / React-DnD threshold detectors fire."""
    fx, fy = int(body["fromX"]), int(body["fromY"])
    tx, ty = int(body["toX"]), int(body["toY"])
    steps = int(body.get("steps", 20))
    hold_ms = int(body.get("hold_ms", 200))
    page.mouse.move(fx, fy)
    page.mouse.down()
    page.wait_for_timeout(hold_ms)
    page.mouse.move(fx, fy, steps=2)
    for i in range(1, steps + 1):
        ix = fx + (tx - fx) * i // steps
        iy = fy + (ty - fy) * i // steps
        page.mouse.move(ix, iy, steps=2)
    page.wait_for_timeout(hold_ms)
    page.mouse.up()
    return {"ok": True, "from": [fx, fy], "to": [tx, ty]}


def ep_selector_click(page: Page, body: dict) -> dict:
    page.locator(body["selector"]).first.click(timeout=int(body.get("timeout", 8000)))
    return {"ok": True}


_SET_HTML_EMBED_JS = """
async ({elementId, html}) => {
  const el = document.querySelector('[data-w-id="' + elementId + '"]');
  if (!el) return {ok: false, error: 'element not found by data-w-id'};
  el.click();
  await new Promise(r => setTimeout(r, 400));
  const editBtn = Array.from(document.querySelectorAll('button'))
    .find(b => /edit code/i.test(b.textContent || ''));
  if (!editBtn) return {ok: false, error: 'Edit Code button not found'};
  editBtn.click();
  await new Promise(r => setTimeout(r, 800));
  const cm = document.querySelector('.cm-editor');
  if (!cm) return {ok: false, error: 'CodeMirror editor not mounted'};
  const view = cm.cmView && cm.cmView.view;
  if (!view) return {ok: false, error: 'EditorView not attached to .cm-editor'};
  const previousLength = view.state.doc.length;
  view.dispatch({ changes: { from: 0, to: previousLength, insert: html } });
  const newLength = view.state.doc.length;
  return {ok: true, previousLength, newLength};
}
"""


def ep_set_html_embed(page: Page, body: dict) -> Any:
    payload = {"elementId": body["elementId"], "html": body["html"]}
    return page.evaluate(_SET_HTML_EMBED_JS, payload)


def ep_create_page(page: Page, body: dict) -> dict:
    """Drive the Designer's "+ Add page → Create page" UI flow.

    1. Open Pages panel via left-sidebar-pages-button
    2. Click add-page-menu-button to open the menu
    3. Click new-page menuitem to open the "New Page settings" modal
    4. Type name + slug into PageSettingsForm-untitled-page-name/slug-input
    5. Click create-new-page-button

    The Designer's React handlers don't fire on synthetic .click() events,
    so click_aid_by_coords uses Playwright's full pointer-event pipeline.
    Selectors verified 2026-05-07 against lisa-blockcast.design.webflow.com.
    """
    name = (body.get("name") or "").strip()
    slug = (body.get("slug") or "").strip()
    if not name:
        return {"ok": False, "error": "name required"}

    # 1. Pages panel — only click if it's not already open. The
    # left-sidebar-pages-button TOGGLES, so a blind click closes an
    # already-open panel and the next steps fail.
    already_open = page_ops.run_in_page(
        page,
        "const b = document.querySelector('[data-automation-id=\"left-sidebar-pages-button\"]');"
        " return b && b.getAttribute('aria-pressed') === 'true';",
    )
    if not already_open:
        page_ops.click_aid_by_coords(page, "left-sidebar-pages-button", settle_ms=800)

    # 2. Add-page menu (wait until the panel's add button is in the DOM
    # to absorb panel mount/animation latency)
    for _ in range(10):
        present = page_ops.run_in_page(
            page,
            "return !!document.querySelector('[data-automation-id=\"add-page-menu-button\"]');",
        )
        if present:
            break
        page.wait_for_timeout(200)
    page_ops.click_aid_by_coords(page, "add-page-menu-button", settle_ms=400)

    # 3. "Create page" menuitem
    page_ops.click_aid_by_coords(page, "new-page", settle_ms=800)

    # 4. Fill name. Webflow embeds a slugified copy of the current page
    # name in the form fields' data-automation-ids, so the IDs change AS
    # WE TYPE the name (`PageSettingsForm-untitled-...` →
    # `PageSettingsForm-<slugified-name>-...`). Using a suffix selector
    # `[data-automation-id$="-page-name-input-input"]` is stable across
    # those edits.
    page_ops.fill_locator(page, '[data-automation-id$="-page-name-input-input"]', name)
    page.wait_for_timeout(400)
    if slug:
        page_ops.fill_locator(page, '[data-automation-id$="-page-slug-input-input"]', slug)
        page.wait_for_timeout(300)

    # 5. Create
    page_ops.click_aid_by_coords(page, "create-new-page-button", settle_ms=1500)

    new_page_name = page_ops.run_in_page(
        page,
        "const b = document.querySelector('[data-automation-id=top-bar-page-name]');"
        " return b ? (b.textContent || '').trim() : null;",
    )
    return {"ok": True, "topBarPageName": new_page_name, "url": page.url}


ROUTES = {
    "/screenshot": ep_screenshot,
    "/eval": ep_eval,
    "/key": ep_key,
    "/click": ep_click,
    "/dblclick": ep_dblclick,
    "/drag": ep_drag,
    "/selectorClick": ep_selector_click,
    "/setHtmlEmbed": ep_set_html_embed,
    "/createPage": ep_create_page,
}
