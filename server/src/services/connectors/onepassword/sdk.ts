import { createClient, type Client, type ItemCreateParams, type ItemField } from "@1password/sdk";
import { onePasswordArguments } from "./catalog.js";

export async function executeOnePasswordSdk(token: string, tool: string, parameters: unknown,
  authenticate: (token: string) => Promise<Client> = token => createClient({ auth: token, integrationName: "Paperclip", integrationVersion: "1.0.0" })) {
  const args = onePasswordArguments(tool, parameters);
  const client = await authenticate(token);
  const vaultId = args.vaultId as string, itemId = args.itemId as string;
  switch (tool) {
    case "onepassword_list_vaults": return client.vaults.list();
    case "onepassword_list_items": return client.items.list(vaultId);
    case "onepassword_get_item": return client.items.get(vaultId, itemId);
    case "onepassword_resolve_secret": return { value: await client.secrets.resolve(args.reference as string) };
    case "onepassword_create_item": return client.items.create(args as unknown as ItemCreateParams);
    case "onepassword_update_item": {
      const current = await client.items.get(vaultId, itemId);
      return client.items.put({ ...current,
        ...(args.title !== undefined ? { title: args.title as string } : {}),
        ...(args.notes !== undefined ? { notes: args.notes as string } : {}),
        ...(args.fields !== undefined ? { fields: args.fields as ItemField[] } : {}),
        ...(args.tags !== undefined ? { tags: args.tags as string[] } : {}),
      });
    }
    case "onepassword_archive_item": await client.items.archive(vaultId, itemId); return { archived: true };
    case "onepassword_delete_item": await client.items.delete(vaultId, itemId); return { deleted: true };
    default: throw new Error("Unknown 1Password action");
  }
}
