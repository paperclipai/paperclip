import { readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { chromium, test } from "@playwright/test";
import { readValidatedPublicOriginReceipt } from "../chat-public-origin.js";
import {
  validPublicSignInInput,
  publicSignInStorageMatches,
  type PublicSignInInput,
} from "./external-public-signin-contract.js";

async function main() {
  let attached = false;
  try {
    test.info();
    attached = true;
  } catch {
    /* standalone process */
  }
  if (attached)
    throw new Error("Private public sign-in cannot run inside Test");
  const file = process.argv[2]!;
  const metadata = await stat(file);
  if (
    !metadata.isFile() ||
    metadata.mode & 0o077 ||
    metadata.size > 32768 ||
    metadata.uid !== process.getuid?.()
  )
    throw new Error("Invalid private public sign-in input file");
  const input = JSON.parse(
    await readFile(file, "utf8"),
  ) as PublicSignInInput & { executablePath?: string; channel?: string };
  if (!validPublicSignInInput(input))
    throw new Error("Invalid finite public sign-in input");
  const origin = await readValidatedPublicOriginReceipt({
    receiptPath: input.receiptPath,
    executionId: input.executionId,
    attemptId: input.attemptId,
    backendOrigin: input.backendOrigin,
  });
  if (origin.publicOrigin !== input.publicOrigin)
    throw new Error(
      "Public sign-in origin does not match this validated owned attempt",
    );
  const browser = await chromium.launch({
    headless: true,
    ...(input.executablePath ? { executablePath: input.executablePath } : {}),
    ...(input.channel ? { channel: input.channel } : {}),
  });
  try {
    const context = await browser.newContext({ baseURL: origin.publicOrigin });
    let requests = 0;
    await context.route("**/*", async (route) => {
      if (
        ++requests > 200 ||
        new URL(route.request().url()).origin !== origin.publicOrigin
      )
        await route.abort();
      else await route.continue();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    await page.goto(`${origin.publicOrigin}/auth?next=%2F`, {
      waitUntil: "domcontentloaded",
    });
    await page
      .getByRole("heading", { name: "Sign in to Paperclip", exact: true })
      .waitFor();
    const email = page.getByLabel("Email", { exact: true }),
      password = page.getByLabel("Password", { exact: true });
    if ((await password.getAttribute("type")) !== "password")
      throw new Error("Public sign-in password field is not protected");
    await email.fill(input.email);
    await password.fill(input.password);
    const signedIn = page.waitForResponse(
      (response) =>
        response.url() === `${origin.publicOrigin}/api/auth/sign-in/email` &&
        response.request().method() === "POST" &&
        response.ok(),
    );
    await page.getByRole("button", { name: "Sign In", exact: true }).click();
    const response = await signedIn;
    const submitted = response.request().postDataJSON() as {
      email?: string;
      password?: string;
    };
    const result = (await response.json()) as { user?: { id?: string } };
    if (
      submitted.email !== input.email ||
      submitted.password !== input.password ||
      result.user?.id !== input.userId
    )
      throw new Error(
        "Public sign-in form did not authenticate the generated fixture person",
      );
    const sessionResponse = await context.request.get(
      `${origin.publicOrigin}/api/auth/get-session`,
      { maxRedirects: 0 },
    );
    if (
      !sessionResponse.ok() ||
      (await sessionResponse.json()).user?.id !== input.userId
    )
      throw new Error(
        "Public session identity does not match the generated fixture person",
      );
    await password.waitFor({ state: "detached" });
    if (new URL(page.url()).origin !== origin.publicOrigin)
      throw new Error(
        "Public sign-in navigated outside its exact owned origin",
      );
    const storage = await context.storageState();
    if (!publicSignInStorageMatches(storage, origin.publicOrigin))
      throw new Error("Public sign-in produced an unexpected storage domain");
    await writeFile(
      path.join(path.dirname(file), "storage.json"),
      JSON.stringify(storage),
      { mode: 0o600 },
    );
    return {
      processIsolation: true,
      testRunnerAttached: false,
      tracingEnabled: false,
      videoEnabled: false,
      apiStepRecorder: false,
      userId: input.userId,
      signedIn: true,
      publicDomainOnly: true,
    };
  } finally {
    await browser.close();
  }
}
main()
  .then((receipt) => process.stdout.write(JSON.stringify(receipt)))
  .catch(() => {
    process.stderr.write("Private public sign-in failed; diagnostics withheld");
    process.exitCode = 1;
  });
