import type { Meta, StoryObj } from "@storybook/react-vite";
import { AppLogo } from "@/pages/apps/AppLogo";
import manifest from "../../public/brands/apps/manifest.json";

const sizes = [24, 28, 32, 36, 44, 48];
const launchOrder = ["gmail", "google-calendar", "slack", "stripe"];
const providers = [...manifest.providers].sort((a, b) => {
  const rank = (slug: string) => launchOrder.includes(slug) ? launchOrder.indexOf(slug) : launchOrder.length;
  return rank(a.slug) - rank(b.slug) || a.provider.localeCompare(b.provider);
});

function Registry() {
  return (
    <div className="bg-background p-6 text-foreground">
      <h1 className="text-xl font-semibold">Connector icon registry — test fixtures</h1>
      <p className="my-4 text-sm text-muted-foreground">
        Synthetic specimens using the shared AppLogo and local manifest. Brand library membership does not enable a connector.
        Columns include specimen sizes and actual caller sizes; gray frames and standard inner spacing are unchanged.
      </p>
      <table className="w-full text-sm">
        <thead><tr><th className="p-2 text-left">Identity</th>{sizes.map((size) => <th className="p-2" key={size}>{size}px</th>)}<th className="p-2 text-left">Selection</th></tr></thead>
        <tbody>{providers.map((provider) => (
          <tr key={provider.slug} data-brand={provider.slug}>
            <th className="p-2 text-left font-medium">{provider.provider}</th>
            {sizes.map((size) => <td className="p-2 text-center" key={size}><AppLogo name={provider.provider} brandKey={provider.slug} size={size} allowRemoteFallback={false} /></td>)}
            <td className="p-2 text-muted-foreground">{provider.catalogVisible ? "Catalog" : "Brand library"}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

const meta = { title: "Apps/Canonical icon registry", component: Registry, parameters: { layout: "fullscreen" } } satisfies Meta<typeof Registry>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Light: Story = { globals: { theme: "light" } };
export const Dark: Story = { globals: { theme: "dark" } };
