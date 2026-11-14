import { journeyCapabilities, journeyFeatureIds, journeyFeatureMap, journeyFeatures } from "./journey-features.js";
import type { ReportExecution } from "./report-catalog.js";

function html(value: unknown) {
  return String(value ?? "").replace(/[&<>"']/g, (character) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
}

export function renderJourneyFeatureOptions(catalog: readonly ReportExecution[]) {
  const selected = new Set(catalog.flatMap(journeyFeatureIds));
  return journeyFeatureMap.sections.map((section) => {
    const features = section.features.filter((feature) => selected.has(feature.id));
    return features.length ? `<optgroup label="${html(section.title)}">${features.map((feature) =>
      `<option value="${html(feature.id)}">${html(feature.title)}</option>`,
    ).join("")}</optgroup>` : "";
  }).join("") + (catalog.some((execution) => journeyCapabilities(execution).length === 0)
    ? '<option value="__unmapped__">Unmapped journeys</option>' : "");
}

export function renderJourneyFeatureCoverage(
  catalog: readonly ReportExecution[],
  entries: ReadonlyMap<string, { valid: boolean }>,
) {
  const linked = new Set(catalog.flatMap((execution) => journeyCapabilities(execution).map((capability) => capability.id)));
  const mappedTests = catalog.filter((execution) => journeyCapabilities(execution).length > 0).length;
  const totalCapabilities = journeyFeatures.reduce((total, feature) => total + feature.capabilities.length, 0);
  return `<details class="feature-coverage" id="feature-coverage">
    <summary>Feature coverage <span>${linked.size} of ${totalCapabilities} capabilities linked · ${mappedTests} of ${catalog.length} tests mapped</span></summary>
    <p>Associations use the current feature map. Counts describe linked test scenarios; a passing journey does not establish full coverage of a capability.</p>
    ${mappedTests < catalog.length ? `<button type="button" class="feature-choice" data-report-feature-choice="__unmapped__">Find ${catalog.length - mappedTests} unmapped tests</button>` : ""}
    <div class="feature-coverage-sections">${journeyFeatureMap.sections.map((section) => `<section>
      <h3>${html(section.title)}</h3>
      <table><thead><tr><th>Feature</th><th>Capabilities linked</th><th>Linked test results</th></tr></thead><tbody>${section.features.map((feature) => {
        const tests = catalog.filter((execution) => journeyFeatureIds(execution).includes(feature.id));
        const mapped = feature.capabilities.filter((capability) => linked.has(capability.id));
        const passed = tests.filter((execution) => entries.get(execution.id)?.valid).length;
        const missing = tests.filter((execution) => !entries.has(execution.id)).length;
        return `<tr><th scope="row">${tests.length
          ? `<button type="button" class="feature-choice" data-report-feature-choice="${html(feature.id)}">${html(feature.title)}</button>`
          : html(feature.title)}<small>${mapped.map((capability) => html(capability.label)).join(" · ")}</small></th>
          <td>${mapped.length}/${feature.capabilities.length}</td>
          <td>${tests.length ? `${passed}/${tests.length} passed${tests.length - passed - missing ? ` · ${tests.length - passed - missing} failed or incomplete` : ""}${missing ? ` · ${missing} missing` : ""}` : "No mapped journey"}</td></tr>`;
      }).join("")}</tbody></table>
    </section>`).join("")}</div>
  </details>`;
}

export const journeyFeatureStyles = `
  .feature-coverage { margin: 0 0 24px; padding: 14px 0; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
  .feature-coverage > summary { cursor: pointer; font-weight: 600; }
  .feature-coverage > summary span { margin-left: 12px; color: var(--muted-foreground); font-size: 12px; font-weight: 400; }
  .feature-coverage > p { max-width: 780px; color: var(--muted-foreground); font-size: 12px; }
  .feature-coverage-sections { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 24px; margin-top: 24px; }
  .feature-coverage h3 { margin: 0 0 12px; font-size: 14px; }
  .feature-coverage table { width: 100%; border-collapse: collapse; font-size: 11px; }
  .feature-coverage th, .feature-coverage td { padding: 10px 8px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
  .feature-coverage thead th { color: var(--muted-foreground); font-weight: 500; }
  .feature-coverage th small { display: block; margin-top: 4px; color: var(--muted-foreground); font-weight: 400; }
  .feature-choice { padding: 0; border: 0; background: transparent; color: inherit; cursor: pointer; font: inherit; text-align: left; text-decoration: underline; text-underline-offset: 3px; }
  .case-features { display: flex; flex-wrap: wrap; gap: 4px 12px; margin: 8px 0; color: var(--muted-foreground); font-size: 10px; }
  @media (max-width: 860px) { .feature-coverage-sections { grid-template-columns: 1fr; } .feature-coverage > summary span { display: block; margin: 4px 0 0; } }
`;
