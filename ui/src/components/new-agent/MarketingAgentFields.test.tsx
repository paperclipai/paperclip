// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createMarketingAgentProfile, type MarketingAgentProfile } from "@paperclipai/shared/marketing-agents";
import { MarketingAgentFields } from "./MarketingAgentFields";

let root: Root;
let host: HTMLDivElement;
let latest: MarketingAgentProfile | null;
function Form({ initial = null }: { initial?: MarketingAgentProfile | null }) {
  const [profile, setProfile] = useState(initial);
  latest = profile;
  return <MarketingAgentFields value={profile} onChange={setProfile} />;
}
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); latest = null; });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function choose(label: string) {
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Tipo de agente"]')!.click());
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(item => item.textContent === label)!.click());
}
it("lists all twelve types and fills an editable profile without account or model fields", async () => {
  await act(async () => root.render(<Form />));
  expect(latest).toBeNull();
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Tipo de agente"]')!.click());
  expect(document.querySelectorAll('[role="option"]')).toHaveLength(12);
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(item => item.textContent === "Social Media")!.click());
  expect(latest!.typeId).toBe("social_media");
  expect(host.querySelectorAll("textarea")).toHaveLength(5);
  expect(latest).not.toHaveProperty("model");
  expect(latest).not.toHaveProperty("connection");
});
it("requires an explicit decision before replacing customized instructions on a type change", async () => {
  const original = { ...createMarketingAgentProfile("designer"), instructions: "Minha instrução", specialization: "Marca A" };
  await act(async () => root.render(<Form initial={original} />));
  await choose("Motion Designer");
  expect(latest!.typeId).toBe("designer");
  await act(async () => [...host.querySelectorAll("button")].find(item => item.textContent === "Manter personalizações")!.click());
  expect(latest).toMatchObject({ typeId: "motion_designer", instructions: "Minha instrução", specialization: "Marca A" });
  await choose("Designer");
  await act(async () => [...host.querySelectorAll("button")].find(item => item.textContent === "Aplicar novo modelo")!.click());
  expect(latest!.instructions).toBe(createMarketingAgentProfile("designer").instructions);
  expect(latest!.specialization).toBe("Marca A");
});
