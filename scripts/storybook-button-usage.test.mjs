import assert from "node:assert/strict";
import test from "node:test";
import { buttonReferences } from "./storybook-button-usage.mjs";

test("button usage follows canonical imports and aliases, excluding native and unrelated buttons", () => {
  const entries = buttonReferences(`
    import { Button as Action } from '@/components/ui/button';
    import * as UI from './ui/button';
    import { Button } from './OtherButton';
    export const View = () => <><Action variant="outline" size="sm" /><UI.Button /><Button /><button /></>;
  `, "ui/src/components/Example.tsx", "app");
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map(({ variant, size, scope }) => ({ variant, size, scope })), [
    { variant: "outline", size: "sm", scope: "app" }, { variant: "default", size: "default", scope: "app" },
  ]);
});

test("dynamic props and spread precedence are not reported as known defaults", () => {
  const entries = buttonReferences(`
    import { Button } from '@/components/ui/button';
    export const View = () => <><Button {...props} /><Button variant={style} /><Button variant="cta" {...props} /><Button {...props} variant="ghost" /></>;
  `, "ui/src/pages/Example.tsx", "app");
  assert.deepEqual(entries.map(entry => entry.variant), ["dynamic / spread", "dynamic", "dynamic / spread", "ghost"]);
  assert.deepEqual(entries.map(entry => entry.size), ["dynamic / spread", "default", "dynamic / spread", "dynamic / spread"]);
});
