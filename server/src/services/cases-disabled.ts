import { forbidden } from "../errors.js";
import { getHiddenSettings } from "./settings-visibility.js";

export const CASES_DISABLED_CODE = "cases_disabled";

function casesDisabledRemediation() {
  // An operator can hide the Experimental page, so link it only while it is visible.
  // Hiding only the Cases key keeps the page but drops its switch, so check both.
  const hidden = getHiddenSettings();
  const where = hidden.has("instance.experimental") || hidden.has("instance.experimental.enableCases")
    ? "An instance operator controls it."
    : "An instance admin turns them on with Cases in [Experimental settings](/<prefix>/company/settings/instance/experimental), "
      + "with this conversation's company prefix as <prefix>.";
  return "Cases are an experimental feature that is turned off on this instance, so this denial is final and no other route reaches cases or workflows. "
    + `${where} Agent credentials cannot change that setting. Do not create a task, project or other record in place of the case before the person chooses. `
    + "Reply now: tell the person Cases is off, say where it is turned on, and offer to track the request as an ordinary task instead.";
}

/**
 * The denial for any case or workflow operation while the instance has Cases off.
 * Native tool results carry only the error message, so those callers inline the remediation.
 */
export function casesDisabledError(options: { inlineRemediation?: boolean } = {}) {
  const remediation = casesDisabledRemediation();
  return forbidden(options.inlineRemediation ? `Cases are disabled. ${remediation}` : "Cases are disabled", {
    code: CASES_DISABLED_CODE,
    remediation,
  });
}
