import { readFileSync } from "node:fs";
import { parseSync } from "oxc-parser";
import { transformSync } from "esbuild";
import { expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { describeUiError, localizeUiError, uiErrorDescriptor } from "./localized-ui-error";
// Exercise exact production callback bodies, without importing the app bootstrap
// or mocking React Query's mutation execution and error flow.
function callback(file: string, mutationName: string, property: string, deps: Record<string, unknown>) {
  const text = readFileSync(new URL(file, import.meta.url), "utf8");
  const ast = parseSync(file, text).program;
  let result = "";
  function visit(node: any) {
    if (!node || typeof node !== "object") return;
    if (node.type === "VariableDeclarator" && node.id?.name === mutationName) {
      const prop = node.init?.arguments?.[0]?.properties?.find((p: any) => p.key?.name === property);
      if (prop) result = text.slice(prop.value.start, prop.value.end);
    }
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === "object") visit(child);
    }
  }
  visit(ast); expect(result).not.toBe("");
  const code = transformSync(`const callback = ${result}`, { loader: "tsx", target: "es2022" }).code;
  return new Function(...Object.keys(deps), `${code}; return callback;`)(...Object.values(deps));
}
it("opts owned product-copy toasts into the explicit presentation contract", () => {
  for (const file of ["../components/IssueChatThread.tsx", "../components/IssueRunLedger.tsx"]) {
    const ast = parseSync(file, readFileSync(new URL(file, import.meta.url), "utf8")).program;
    let count = 0;
    function visit(node: any) {
      if (!node || typeof node !== "object") return;
      if (node.type === "CallExpression" && (node.callee?.property?.name === "pushToast" || node.callee?.name === "pushToast")) {
        const props = node.arguments[0]?.properties ?? [];
        if (props.some((p: any) => p.key?.name === "title" && p.value?.type === "CallExpression" && p.value?.callee?.name === "t")) {
          count++; expect(props.some((p: any) => p.key?.name === "presentation"), file).toBe(true);
        }
      }
      for (const child of Object.values(node)) { if (Array.isArray(child)) child.forEach(visit); else if (child && typeof child === "object") visit(child); }
    }
    visit(ast); expect(count).toBeGreaterThan(0);
  }
});
it("keeps trace skip fallback explicit, held toast reactive and vendor collisions raw", async () => {
  const request = vi.fn().mockResolvedValue({}); const pushToast = vi.fn();
  const deps = { agentsApi: { wakeup: request }, asRecord: (value: unknown) => value && typeof value === "object" ? value : null, readString: (value: unknown) => typeof value === "string" ? value : null, issueId: "raw-task", companyId: "raw-org", localizeUiError, uiErrorDescriptor, t: (key: string) => i18n.t(key), pushToast };
  const run = callback("../components/IssueRunLedger.tsx", "rerunWithTrace", "mutationFn", deps);
  const onError = callback("../components/IssueRunLedger.tsx", "rerunWithTrace", "onError", deps);
  let error: unknown; await run({ runId: "raw-run", agentId: "raw-agent" }).catch((e: unknown) => { error = e; onError(e); });
  expect(request).toHaveBeenCalledTimes(1); expect(error).toBeInstanceOf(Error); expect((error as Error).message).toBe("Trace re-run was skipped.");
  expect(pushToast).toHaveBeenCalledTimes(1); const toast = pushToast.mock.calls[0][0];
  expect(toast.presentation?.body?.key).toBe("final-boundary:traceSkipped");
  await i18n.changeLanguage("zh-CN"); expect(i18n.t(toast.presentation.body.key)).toBe("已跳过跟踪重跑。");
  await i18n.changeLanguage("en"); expect(request).toHaveBeenCalledTimes(1);
  request.mockResolvedValue({ message: "Trace re-run was skipped." });
  await run({ runId: "raw-run", agentId: "raw-agent" }).catch((e: unknown) => onError(e));
  expect(pushToast.mock.calls[1][0].presentation.body).toBeUndefined();
  expect(pushToast.mock.calls[1][0].body).toBe("Trace re-run was skipped.");
});
it("keeps select-organization guard and API outcome while explicitly tagging only its own Error", async () => {
  const create = vi.fn().mockResolvedValue({ id: "raw-secret" });
  const run = (id: string | null) => callback("../components/ProjectProperties.tsx", "createSecret", "mutationFn", { selectedCompanyId: id, secretsApi: { create }, localizeUiError });
  let error: unknown; try { await run(null)({ name: "raw_name", value: "do-not-log" }); } catch (e) { error = e; }
  expect(create).not.toHaveBeenCalled(); expect(error).toBeInstanceOf(Error); expect((error as Error).message).toBe("Select an organization to create secrets");
  await i18n.changeLanguage("zh-CN"); expect(describeUiError(error).body).toBe("请选择组织以创建密钥");
  expect(describeUiError(new Error("Select an organization to create secrets")).body).toBe("Select an organization to create secrets");
  await i18n.changeLanguage("en"); expect(describeUiError(error).body).toBe("Select an organization to create secrets");
  await expect(run("raw-org")({ name: "raw_name", value: "do-not-log" })).resolves.toEqual({ id: "raw-secret" }); expect(create).toHaveBeenCalledTimes(1);
});
