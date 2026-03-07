import { describe, expect, it, vi } from "vitest";
import { setBetterAuthUserPassword } from "../auth/better-auth.js";

describe("setBetterAuthUserPassword", () => {
  it("updates an existing credential password and revokes sessions", async () => {
    const hash = vi.fn(async (password: string) => `hashed:${password}`);
    const findUserById = vi.fn(async () => ({ id: "user-1" }));
    const findAccounts = vi.fn(async () => [{ id: "account-1", providerId: "credential", password: "old" }]);
    const updatePassword = vi.fn(async () => undefined);
    const linkAccount = vi.fn(async () => undefined);
    const deleteSessions = vi.fn(async () => undefined);

    await setBetterAuthUserPassword(
      {
        $context: Promise.resolve({
          password: {
            hash,
            config: { minPasswordLength: 8, maxPasswordLength: 128 },
          },
          internalAdapter: {
            findUserById,
            findAccounts,
            updatePassword,
            linkAccount,
            deleteSessions,
          },
        }),
      } as never,
      { userId: "user-1", newPassword: "new-password" },
    );

    expect(hash).toHaveBeenCalledWith("new-password");
    expect(updatePassword).toHaveBeenCalledWith("user-1", "hashed:new-password");
    expect(linkAccount).not.toHaveBeenCalled();
    expect(deleteSessions).toHaveBeenCalledWith("user-1");
  });

  it("links a credential account when the user does not already have one", async () => {
    const hash = vi.fn(async (password: string) => `hashed:${password}`);
    const linkAccount = vi.fn(async () => undefined);

    await setBetterAuthUserPassword(
      {
        $context: Promise.resolve({
          password: {
            hash,
            config: { minPasswordLength: 8, maxPasswordLength: 128 },
          },
          internalAdapter: {
            findUserById: async () => ({ id: "user-2" }),
            findAccounts: async () => [],
            updatePassword: async () => undefined,
            linkAccount,
            deleteSessions: async () => undefined,
          },
        }),
      } as never,
      { userId: "user-2", newPassword: "fresh-pass" },
    );

    expect(linkAccount).toHaveBeenCalledWith({
      userId: "user-2",
      providerId: "credential",
      accountId: "user-2",
      password: "hashed:fresh-pass",
    });
  });

  it("rejects passwords shorter than the configured minimum", async () => {
    await expect(
      setBetterAuthUserPassword(
        {
          $context: Promise.resolve({
            password: {
              hash: async () => "unused",
              config: { minPasswordLength: 12, maxPasswordLength: 128 },
            },
            internalAdapter: {
              findUserById: async () => ({ id: "user-3" }),
              findAccounts: async () => [],
              updatePassword: async () => undefined,
              linkAccount: async () => undefined,
              deleteSessions: async () => undefined,
            },
          }),
        } as never,
        { userId: "user-3", newPassword: "short" },
      ),
    ).rejects.toMatchObject({ message: "Password must be at least 12 characters" });
  });
});
