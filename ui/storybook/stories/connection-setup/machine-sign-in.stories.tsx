import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ConnectToolAppResult, MachineSignInSetupResult } from "@paperclipai/shared";
import { MachineSignInSetup, type MachineSignInClient } from "@/features/connections/MachineSignInSetup";

const LINK = "https://mcp.reports.example/mcp";

const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAoBlCS+lp0dZwCGElkUQw
spwT+Q/xmKEF05Tx3hIq1HvAjZBWP1WGbCvfE47bK0nrnQHOYvLjpjFwtA3H/yOL
WevYMfELbZdAsX0hGZYFuEStMUgOK+40hqkBzmmHDhxILvjk2e0F/V6FcYuKMxt6
o1uDJw9D97Go61SPIyNgX9s702/8UPJ1o+ywqj/q20DATDsbg2tmcd0SJGvg0Yvr
5Vfs3pIbeI/W9oD1uwMp+R39qfPkHtXgdphr0zZUT4nQyYYaRkqU3fEt/95wQl5u
ZEhMyxTlUpuSkNJR7+CQ5fKF1eLoC0cBg2GNs/TYkzorEOfF36KRwThWJDcw1OaZ
CQIDAQAB
-----END PUBLIC KEY-----
`;

const draft: MachineSignInSetupResult = {
  connectionId: "connection-1",
  connection: {} as MachineSignInSetupResult["connection"],
  machineSignIn: {
    connectionId: "connection-1",
    method: "paperclip_key",
    clientId: null,
    issuer: "https://auth.reports.example",
    tokenUrl: "https://auth.reports.example/oauth/token",
    scopes: ["reports.read"],
    publicKey: {
      keyId: "qlq2dTOYsBTTtWyaR7QZLShkPOW7XPkzHBgki7R28rg",
      algorithm: "RS256",
      pem: PUBLIC_KEY_PEM,
      jwk: { kty: "RSA", e: "AQAB", n: "oBlCS-lp0dZwCGElkUQw…", kid: "qlq2dTOYsBTTtWyaR7QZLShkPOW7XPkzHBgki7R28rg", alg: "RS256", use: "sig" },
      createdAt: "2026-11-13T12:00:00.000Z",
    },
    pendingPublicKey: null,
    hasClientSecret: false,
    lastTokenAt: null,
  },
};

/** In memory: creating returns the draft above; testing fails until a client ID is entered. */
const fakeClient: MachineSignInClient = {
  create: async () => draft,
  status: async () => draft.machineSignIn,
  test: async (_connectionId, input) => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (input.clientId !== "paperclip-automation") {
      throw new Error("The provider didn't accept Paperclip's key. Check the client ID and that the public key shown here is registered for it.");
    }
    return {} as ConnectToolAppResult;
  },
};

const meta = {
  id: "apps-connections-machine-sign-in",
  title: "Apps, channels, and extensions/Connection setup/Apps/Connections/Machine sign-in",
  component: MachineSignInSetup,
  args: { companyId: "company-1", link: LINK, client: fakeClient, onBack: () => undefined, onConnected: () => undefined },
  parameters: {
    layout: "padded",
    docs: { description: { component: "Machine sign-in (client credentials) for an organization connection, with in-memory provider responses. Use client ID `paperclip-automation` to see a successful test." } },
    paperclip: {
      "capabilities": [
        "connection-setup/credentials",
        "connection-setup/failure"
      ],
      "implementation": "production",
      "boundary": "fixtures"
    },
  },
  decorators: [(Story) => <div className="mx-auto max-w-xl"><Story /></div>],
} satisfies Meta<typeof MachineSignInSetup>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Default: Paperclip creates a key; the sign-in service is found from the server. */
export const ChooseKey: Story = {};

export const ChooseClientSecret: Story = { args: { initialMethod: "client_secret" } };

/** After "Create key": the public key to register, then the client ID and test. */
export const RegisterPublicKey: Story = { args: { initialSetup: draft } };

export const TestFailed: Story = {
  args: {
    initialSetup: { ...draft, machineSignIn: { ...draft.machineSignIn, clientId: "wrong-client" } },
    initialError: "The provider didn't accept Paperclip's key. Check the client ID and that the public key shown here is registered for it.",
  },
};

export const SignInServiceChanged: Story = {
  args: {
    initialSetup: { ...draft, machineSignIn: { ...draft.machineSignIn, clientId: "paperclip-automation" } },
    initialError: "This server now sends sign-in to a different service (login.other.example). Paperclip won't send this connection's credentials there. Set up machine sign-in again to trust the new service.",
  },
};

export const NarrowRegisterPublicKey: Story = {
  args: { initialSetup: draft },
  globals: { viewport: { value: "mobile", isRotated: false } },
};
