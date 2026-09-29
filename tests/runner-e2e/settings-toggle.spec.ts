import { expect, test } from "@playwright/test";
import { setSettingsToggle } from "./settings-toggle.js";

test("waits for a controlled switch and does not toggle an already-saved value", async ({ page }) => {
  await page.setContent(`<button role="switch" aria-checked="false" onclick="this.disabled=true;setTimeout(()=>{this.setAttribute('aria-checked',this.getAttribute('aria-checked')!=='true');this.disabled=false},100)">Chat</button>`);
  const toggle = page.getByRole("switch");
  await setSettingsToggle(toggle, true);
  await setSettingsToggle(toggle, true);
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await setSettingsToggle(toggle, false);
});
