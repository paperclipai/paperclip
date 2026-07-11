import { describe, expect, it } from "vitest";
import { Keypair, MessageV0, PublicKey, VersionedTransaction } from "@solana/web3.js";
import type { VersionedBlockResponse } from "@solana/web3.js";
import { mapVersionedTransaction } from "./source.js";

describe("mapVersionedTransaction", () => {
  it("includes address-lookup-table keys in the mapped account list", () => {
    const feePayer = Keypair.generate().publicKey;
    const program = Keypair.generate().publicKey;
    const writableLoaded = Keypair.generate().publicKey;
    const readonlyLoaded = Keypair.generate().publicKey;

    const message = new MessageV0({
      header: {
        numRequiredSignatures: 1,
        numReadonlySignedAccounts: 0,
        numReadonlyUnsignedAccounts: 1,
      },
      staticAccountKeys: [feePayer, program],
      recentBlockhash: "4uQeVj5dmVi7rX8S6eY5JHd8Wg9u",
      compiledInstructions: [
        {
          programIdIndex: 1,
          accountKeyIndexes: [0, 2, 3],
          data: new Uint8Array([1, 2, 3]),
        },
      ],
      addressTableLookups: [],
    });

    const tx = new VersionedTransaction(message, [new Uint8Array(64).fill(1)]);
    const raw = {
      transaction: tx,
      meta: {
        err: null,
        fee: 5000,
        preBalances: [1000000000n],
        postBalances: [999995000n],
        logMessages: [],
        loadedAddresses: {
          writable: [writableLoaded],
          readonly: [readonlyLoaded],
        },
      },
      version: 0,
    } as unknown as VersionedBlockResponse["transactions"][number];

    const parsed = mapVersionedTransaction(raw, 123n, 1000);

    expect(parsed).not.toBeNull();
    expect(parsed!.feePayer).toBe(feePayer.toBase58());
    expect(parsed!.accountKeys).toEqual([
      feePayer.toBase58(),
      program.toBase58(),
      writableLoaded.toBase58(),
      readonlyLoaded.toBase58(),
    ]);
    expect(parsed!.instructions[0]!.programId).toBe(program.toBase58());
    expect(parsed!.instructions[0]!.accounts).toEqual([
      feePayer.toBase58(),
      writableLoaded.toBase58(),
      readonlyLoaded.toBase58(),
    ]);
  });
});
