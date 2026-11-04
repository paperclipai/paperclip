import { validDevicePrivateInput, type DevicePrivateInput } from "./external-device-private-contract.js";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, test, type Cookie } from "@playwright/test";
import { validGrokRoutinePrivateInput, matchesConfiguredGrokRoutine, type GrokRoutinePrivateInput } from "./external-grok-private-contract.js";
import { validSlackIdentityInput, validSlackWizardIdentityInput, matchingSlackIdentityPreview, type SlackIdentityPrivateInput } from "./external-slack-identity-contract.js";
import { validSlackSetupPrivate, type SlackSetupPrivateInput } from "./external-slack-setup-private-contract.js";
interface Request { mode: "secure-key" | "canary" | "gateway-token-rotation" | "company-secret-create" | "personal-secret-create" | "grok-routine-configure" | "slack-identity-confirm" | "slack-endpoint-configure" | "slack-wizard-confirm" | "slack-wizard-resume" | "slack-endpoint-reconnect" | "device-approve" | "device-expired"; device?: DevicePrivateInput; slackSetup?:SlackSetupPrivateInput; slackIdentity?:SlackIdentityPrivateInput; grok?:GrokRoutinePrivateInput; companyId?:string; personal?:{definitionId:string;userId:string;viaMySecrets?:boolean}; gateway?: { id: string; oldTokenId: string; otherToken: string; endpointPath: string; readName: string }; baseURL: string; setupURL: string; providerURL: string; credential: string; cookies: Cookie[]; executablePath?: string; channel?: string }
/** Separate Node process: no Playwright Test worker, API-step listener or artifact
 * recorder exists. This module never enables tracing, video or screenshots. */
async function main() {
  let attached = false; try { test.info(); attached = true; } catch { /* expected outside Test */ }
  if (attached) throw new Error("Private browser worker cannot run inside Playwright Test");
  const input = JSON.parse(await readFile(process.argv[2]!, "utf8")) as Request;
  if (!input.credential || input.credential.length > (input.mode === "grok-routine-configure" ? 16384 : 8192) || !["secure-key", "canary", "gateway-token-rotation", "company-secret-create", "personal-secret-create", "grok-routine-configure", "slack-identity-confirm", "slack-endpoint-configure", "slack-wizard-confirm", "slack-wizard-resume", "slack-endpoint-reconnect", "device-approve", "device-expired"].includes(input.mode)) throw new Error("Invalid private browser request");
  const base = new URL(input.baseURL);
  if (base.hostname !== "127.0.0.1" || base.protocol !== "http:" || new URL(input.setupURL).origin !== base.origin) throw new Error("Private browser target is outside the disposable loopback instance");
  const browser = await chromium.launch({ headless: true, ...(input.executablePath ? { executablePath: input.executablePath } : {}), ...(input.channel ? { channel: input.channel } : {}) });
  try {
    const context = await browser.newContext({ baseURL: base.origin });
    await context.addCookies(input.cookies); const page = await context.newPage(); page.setDefaultTimeout(30_000);
    if (input.mode === "device-approve" || input.mode === "device-expired") {
      if (!validDevicePrivateInput(input.mode, input.baseURL, input.setupURL, input.companyId, input.device, input.credential) || !input.device) throw new Error("Invalid finite device verification request");
      const session = await context.request.get("/api/auth/get-session");
      if (!session.ok() || (await session.json()).user?.id !== input.device.userId) throw new Error("Device UI requires the same signed-in fixture person");
      const description = page.waitForResponse(response => {
        const url = new URL(response.url());
        return url.origin === base.origin && url.pathname === "/api/mcp/device" && url.searchParams.get("user_code") === input.credential && response.request().method() === "GET";
      });
      await page.goto(input.setupURL, { waitUntil: "domcontentloaded" });
      const described = await description;
      if (input.mode === "device-expired") {
        const body = await described.json();
        if (described.status() !== 404 || body.error !== "invalid_request") throw new Error("Expired device UI did not receive the actual issuer rejection");
        await page.getByText(/expired|invalid/i).first().waitFor();
        if (await page.getByRole("button", { name: "Connect organization", exact: true }).isVisible()) throw new Error("Expired device still offers approval");
        return { processIsolation: true, testRunnerAttached: false, tracingEnabled: false, videoEnabled: false, apiStepRecorder: false, deviceSessionVerified: true, expiredPageVisible: true };
      }
      if (!described.ok()) throw new Error("Device consent description unavailable");
      const request = await described.json();
      if (request.clientName !== "Paperclip disposable CLI" || request.requestedCompanyId !== input.companyId || request.requiresSignIn !== false || request.requestedWrite !== false || request.requestedConfigure !== false || request.agentConnection === true
        || !request.companies?.some((company: { id: string; name: string }) => company.id === input.companyId && company.name === input.device!.companyName)) throw new Error("Device consent does not match the exact owned read-only request");
      await page.getByRole("heading", { name: "Connect Paperclip disposable CLI to Paperclip", exact: true }).waitFor();
      await page.getByText(input.credential.toUpperCase(), { exact: true }).waitFor();
      await page.getByText(input.device.companyName, { exact: true }).waitFor();
      await page.getByText("Read all of your Paperclip data", { exact: true }).waitFor();
      if (await page.getByText("Write all of your Paperclip data", { exact: true }).isVisible()) throw new Error("Device read-only request unexpectedly offers write authority");
      const approval = page.waitForResponse(response => new URL(response.url()).origin === base.origin && new URL(response.url()).pathname === "/api/mcp/device/consent" && response.request().method() === "POST");
      await page.getByRole("button", { name: "Connect organization", exact: true }).click();
      const approved = await approval, submitted = approved.request().postDataJSON();
      if (!approved.ok() || (await approved.json()).status !== "approved" || submitted.userCode !== input.credential || submitted.companyId !== input.companyId || submitted.decision !== "approve" || submitted.allowWrites !== false || submitted.allowConfiguration !== false) throw new Error("Actual device UI did not approve exactly the selected read-only company/code");
      await page.getByRole("heading", { name: "Access approved", exact: true }).waitFor();
      return { processIsolation: true, testRunnerAttached: false, tracingEnabled: false, videoEnabled: false, apiStepRecorder: false, deviceSessionVerified: true, currentCodeVisible: true, companyConsentVisible: true, readScopeVisible: true, humanApproved: true };
    }
    if (input.mode === "canary") {
      await page.setContent('<input type="password" aria-label="App key" autocomplete="off">');
      const field = page.getByLabel("App key"); await field.fill(input.credential);
      if (await field.inputValue() !== input.credential) throw new Error("Canary entry failed");
      return { processIsolation: true, testRunnerAttached: false, credentialEntered: true, tracingEnabled: false, videoEnabled: false, apiStepRecorder: false };
    }
    if(input.mode === "slack-wizard-confirm" || input.mode === "slack-wizard-resume"){
      const identity=input.slackIdentity;
      if(!validSlackWizardIdentityInput(input.companyId,identity,input.setupURL)||!identity)throw new Error("Invalid finite normal Slack wizard identity operation");
      const session=await context.request.get("/api/auth/get-session");if(!session.ok()||(await session.json()).user?.id!==identity.userId)throw new Error("Slack wizard requires the exact same signed-in person");
      const endpointPath=`/api/chat-endpoints/${identity.endpointId}`;
      const before=await context.request.get(endpointPath);if(!before.ok())throw new Error("Slack wizard endpoint missing");const endpoint=await before.json();if(endpoint.companyId!==input.companyId||endpoint.provider!=="slack"||endpoint.status!=="verifying"||endpoint.setup?.step!=="test")throw new Error("Normal Slack wizard is not waiting at actual verified identity/test boundary");
      const principals=await context.request.get(`${endpointPath}/principals`);if(!principals.ok())throw new Error("Slack command discovery unavailable");
      const rows=await principals.json() as Array<{principalId:string;externalDetail:string;lastConnectAt?:string;status:string;paperclipUserId?:string}>;const candidate=rows.filter(row=>row.principalId===identity.principalId&&row.externalDetail===identity.externalDetail&&row.lastConnectAt&&Date.parse(row.lastConnectAt)>=Date.parse(endpoint.setup.testStartedAt));if(candidate.length!==1||(input.mode==="slack-wizard-resume"?(candidate[0]!.status!=="linked"||candidate[0]!.paperclipUserId!==identity.userId):candidate[0]!.status==="linked"))throw new Error("Genuine current Slack connect receipt is required before wizard ownership confirmation");
      await page.goto(input.setupURL,{waitUntil:"domcontentloaded"});
      if(input.mode==="slack-wizard-confirm"){
      const intentResponse=page.waitForResponse(response=>new URL(response.url()).pathname===`${endpointPath}/principals/${identity.principalId}/link-intent`&&response.request().method()==="POST"&&response.status()===201);
      const confirmed=page.waitForResponse(response=>new URL(response.url()).pathname==="/api/chat-identity-links/confirm"&&response.request().method()==="POST"&&response.ok());
      await page.getByRole("button",{name:`Link ${identity.externalLabel} to my Paperclip account`,exact:true}).click();
      const intent=await(await intentResponse).json(),token=new URL(intent.confirmationUrl,base.origin).searchParams.get("token"),confirmation=await confirmed;
      if(!token||confirmation.request().postDataJSON()?.token!==token||(await confirmation.json()).endpointId!==identity.endpointId)throw new Error("Actual Slack ownership button did not confirm its own generated scoped link");
      }
      await page.getByText("Linked to you",{exact:true}).waitFor();
      const linkedResponse=await context.request.get(`${endpointPath}/principals`);if(!linkedResponse.ok()||!(await linkedResponse.json()).some((row:{principalId:string;status:string;paperclipUserId?:string})=>row.principalId===identity.principalId&&row.status==="linked"&&row.paperclipUserId===identity.userId))throw new Error("Wizard ownership did not persist as the exact same person");
      await page.getByRole("button",{name:"Continue to message test",exact:true}).click();
      const activation=page.waitForResponse(response=>new URL(response.url()).pathname===`${endpointPath}/finish`&&response.request().method()==="POST"&&response.ok());
      await page.getByRole("button",{name:"Done",exact:true}).click();const activated=await(await activation).json();
      const afterResponse=await context.request.get(endpointPath);if(!afterResponse.ok())throw new Error("Activated Slack endpoint unavailable");const after=await afterResponse.json();
      if(activated.id!==identity.endpointId||activated.status!=="active"||after.status!=="active"||after.companyId!==input.companyId||after.setup?.step!=="complete")throw new Error("Actual wizard Done did not independently save activation");
      return {processIsolation:true,testRunnerAttached:false,tracingEnabled:false,videoEnabled:false,apiStepRecorder:false,endpointId:identity.endpointId,principalId:identity.principalId,paperclipUserId:identity.userId,identityConfirmed:true,identityUiVisible:true,humanSubmittedSecurely:true,activationUiVisible:true,endpointActive:true,identityWasAlreadyLinked:input.mode==="slack-wizard-resume"};
    }
    if(input.mode === "slack-endpoint-configure" || input.mode === "slack-endpoint-reconnect"){
      const slack=input.slackSetup;
      if(!validSlackSetupPrivate(input.companyId,slack,input.setupURL,input.mode==="slack-endpoint-reconnect")||!slack||!input.companyId)throw new Error("Invalid finite existing Slack credential form");
      const endpointPath=`/api/chat-endpoints/${slack.endpointId}`,beforeResponse=await context.request.get(endpointPath);
      if(!beforeResponse.ok())throw new Error("Owned Slack draft unavailable");
      const before=await beforeResponse.json();
      if(before.companyId!==input.companyId||before.provider!=="slack"||before.assignedAgentId!==slack.agentId||before.setup?.slackSetupMethod!=="existing"||(input.mode==="slack-endpoint-reconnect"?before.providerAccountId!==slack.workspaceId:!!before.providerAccountId))throw new Error("Slack credential form must target the exact fresh existing-app draft");
      await page.goto(input.setupURL,{waitUntil:"domcontentloaded"});
      const bot=page.getByLabel("Bot User OAuth Token",{exact:true}),secret=page.getByLabel("Signing Secret",{exact:true});
      await bot.waitFor();if(await bot.getAttribute("type")!=="password"||await secret.getAttribute("type")!=="password")throw new Error("Slack credential fields are not protected");
      await bot.fill(input.credential);await secret.fill(slack.signingSecret);
      if(await page.getByText("Your Bot User OAuth Token must start with",{exact:false}).isVisible()){
        return {processIsolation:true,testRunnerAttached:false,tracingEnabled:false,videoEnabled:false,apiStepRecorder:false,endpointId:slack.endpointId,slackCredentialUiVisible:true,humanSubmittedSecurely:false,credentialUiRejected:true};
      }

      const saved=page.waitForResponse(response=>new URL(response.url()).pathname===`${endpointPath}/setup`&&response.request().method()==="POST"&&response.ok());
      await page.getByRole("button",{name:input.mode==="slack-endpoint-reconnect"?"Reconnect Slack app":"Connect Slack app",exact:true}).click();const response=await saved,submitted=response.request().postDataJSON();
      if(submitted.action!==(input.mode==="slack-endpoint-reconnect"?"reconnect":"configure")||submitted.credentials?.botToken!==input.credential||submitted.credentials?.signingSecret!==slack.signingSecret)throw new Error("Slack UI submitted another private setup operation");
      const result=await response.json(),afterResponse=await context.request.get(endpointPath);if(!afterResponse.ok())throw new Error("Saved Slack endpoint unavailable");const after=await afterResponse.json();
      if(result.id!==slack.endpointId||after.id!==slack.endpointId||after.companyId!==input.companyId||after.assignedAgentId!==slack.agentId||after.providerAccountId!==slack.workspaceId||!after.setup?.webhookSecretConfigured)throw new Error("Slack UI credential save did not persist the intended real workspace/agent");
      await bot.waitFor({state:"hidden"});const storageClean=await page.evaluate(values=>!values.some(value=>JSON.stringify([Object.entries(localStorage),Object.entries(sessionStorage),document.body.innerText,location.href]).includes(value)),[input.credential,slack.signingSecret]);
      return {processIsolation:true,testRunnerAttached:false,tracingEnabled:false,videoEnabled:false,apiStepRecorder:false,endpointId:slack.endpointId,slackCredentialUiVisible:true,humanSubmittedSecurely:true,storageClean};
    }
    if (input.mode === "slack-identity-confirm") {
      const identity = input.slackIdentity;
      if (!validSlackIdentityInput(input.companyId, identity, input.setupURL) || !identity || !input.companyId) throw new Error("Invalid finite Slack confirmation operation");
      const session = await context.request.get("/api/auth/get-session");
      if (!session.ok() || (await session.json()).user?.id !== identity.userId) throw new Error("Slack confirmation must use the same actual signed-in fixture human");
      const principalsPath = `/api/chat-endpoints/${identity.endpointId}/principals`;
      async function principal() {
        const response = await context.request.get(principalsPath);
        if (!response.ok()) throw new Error("Slack principal cannot be independently read");
        const rows = await response.json() as Array<{ principalId:string; status:string; paperclipUserId?:string; externalDetail?:string }>;
        const matches = rows.filter(row => row.principalId === identity!.principalId && row.externalDetail === identity!.externalDetail);
        if (matches.length !== 1) throw new Error("Slack principal identity is ambiguous");
        return matches[0]!;
      }
      if ((await principal()).status === "linked") throw new Error("Slack identity was already linked before human confirmation");
      await page.goto(input.setupURL, {waitUntil:"domcontentloaded"});
      const row = page.getByRole("list", {name:"People",exact:true}).getByRole("listitem").filter({has:page.getByText(identity.externalLabel,{exact:true})});
      if(await row.count()!==1) throw new Error("Exact unlinked Slack identity is not uniquely visible in Access");
      const issued=page.waitForResponse(response=>new URL(response.url()).pathname===`${principalsPath}/${identity.principalId}/link-intent`&&response.request().method()==="POST"&&response.status()===201);
      await row.getByRole("button", {name:"Create confirmation link",exact:true}).click();
      const intent=await(await issued).json() as {confirmationUrl?:string};
      const confirmation=new URL(intent.confirmationUrl??"",base.origin),token=confirmation.searchParams.get("token");
      if(confirmation.origin!==base.origin||confirmation.pathname!=="/chat-identity/confirm"||!token||token.length<32||token.length>8192||confirmation.hash||confirmation.searchParams.size!==1) throw new Error("Visible identity form returned another confirmation surface");
      const previewResponse = await context.request.get(`/api/chat-identity-links/preview?token=${encodeURIComponent(token)}`);
      if (!previewResponse.ok() || !matchingSlackIdentityPreview(await previewResponse.json(), input.companyId, identity)) throw new Error("Slack link preview targets another company, endpoint or external human");
      await page.goto(confirmation.href, {waitUntil:"domcontentloaded"});
      await page.getByRole("heading", {name:"Link your external identity",exact:true}).waitFor();
      await page.getByText(identity.externalDetail, {exact:false}).waitFor();
      const confirmed = page.waitForResponse(response => new URL(response.url()).pathname === "/api/chat-identity-links/confirm" && response.request().method() === "POST" && response.ok());
      await page.getByRole("button", {name:"Confirm identity",exact:true}).click();
      const response = await confirmed;
      if (response.request().postDataJSON()?.token !== token) throw new Error("Slack confirmation submitted a different one-use token");
      const result = await response.json() as {ok?:boolean;endpointId?:string};
      if (result.ok !== true || result.endpointId !== identity.endpointId) throw new Error("Slack confirmation returned another endpoint");
      await page.getByRole("heading", {name:"Identity linked",exact:true}).waitFor();
      const after = await principal();
      const afterSession = await context.request.get("/api/auth/get-session");
      if (after.status !== "linked" || after.paperclipUserId !== identity.userId || !afterSession.ok() || (await afterSession.json()).user?.id !== identity.userId) throw new Error("Confirmed Slack authority does not bind the same current signed-in person");
      return {processIsolation:true,testRunnerAttached:false,tracingEnabled:false,videoEnabled:false,apiStepRecorder:false,identityConfirmed:true,identityUiVisible:true,principalId:identity.principalId,paperclipUserId:identity.userId,humanSubmittedSecurely:true};
    }
    if (input.mode === "grok-routine-configure") {
      const grok = input.grok;
      if (!validGrokRoutinePrivateInput(input.companyId, grok, input.setupURL) || !grok) {
        throw new Error("Invalid finite Grok routine operation");
      }
      const endpoint = `/api/companies/${input.companyId}/agents/${grok.agentId}/grok-binding`;
      const beforeResponse = await context.request.get(endpoint);
      if (!beforeResponse.ok()) throw new Error("Existing Grok binding is unavailable");
      const before = await beforeResponse.json() as { enabled?: boolean; canConfigureConnection?: boolean; binding?: { id?: string; connected?: boolean; routine?: { revision?: number; configured?: boolean } } };
      if (!before.enabled || !before.canConfigureConnection || before.binding?.id !== grok.bindingId ||
        before.binding.connected !== true || (before.binding.routine?.revision ?? 0) !== grok.expectedRevision) {
        throw new Error("Genuine connected Grok binding and exact revision are required");
      }
      await page.goto(input.setupURL, { waitUntil: "domcontentloaded" });
      const section = page.getByRole("region", { name: "Grok Bot connection", exact: true });
      await section.waitFor();
      if (before.binding.routine?.configured) {
        await section.getByRole("button", { name: "Replace routine credentials", exact: true }).click();
      }
      const urlField = section.getByLabel("Webhook URL", { exact: true });
      const keyField = section.getByLabel("Webhook key", { exact: true });
      if (await urlField.getAttribute("type") !== "password" || await keyField.getAttribute("type") !== "password") {
        throw new Error("Grok credential fields are not protected");
      }
      await section.getByLabel("Bot name in Grok", { exact: true }).fill(grok.botName);
      await urlField.fill(grok.webhookUrl);
      await keyField.fill(input.credential);
      const savedResponse = page.waitForResponse(response => new URL(response.url()).pathname === `${endpoint}/routine` &&
        response.request().method() === "PUT" && response.ok());
      await section.getByRole("button", { name: "Save routine", exact: true }).click();
      const response = await savedResponse;
      const submitted = response.request().postDataJSON() as { bindingId?: string; expectedRevision?: number; botName?: string; webhookUrl?: string; webhookKey?: string };
      if (submitted.bindingId !== grok.bindingId || submitted.expectedRevision !== grok.expectedRevision ||
        submitted.botName !== grok.botName || submitted.webhookUrl !== grok.webhookUrl || submitted.webhookKey !== input.credential) {
        throw new Error("Grok form did not submit the intended scoped private configuration");
      }
      const saved = await response.json() as { bindingId?: string; configured?: boolean; verified?: boolean; revision?: number };
      if (!matchesConfiguredGrokRoutine(saved, grok.bindingId, grok.expectedRevision)) {
        throw new Error("Grok routine response does not match the configured unverified binding");
      }
      await section.getByRole("button", { name: "Verify connection", exact: true }).waitFor();
      await keyField.waitFor({ state: "detached" });
      const afterResponse = await context.request.get(endpoint);
      if (!afterResponse.ok()) throw new Error("Saved Grok binding could not be independently read");
      const after = await afterResponse.json() as { binding?: { id?: string; connected?: boolean; routine?: { configured?: boolean; revision?: number } } };
      if (after.binding?.id !== grok.bindingId || after.binding.connected !== true ||
        after.binding.routine?.configured !== true || after.binding.routine.revision !== saved.revision) {
        throw new Error("Saved Grok configuration did not persist on the same connected binding");
      }
      const storageClean = await page.evaluate(values => !values.some(value =>
        JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage), document.body.innerText, location.href]).includes(value)),
      [input.credential, grok.webhookUrl]);
      return { processIsolation: true, testRunnerAttached: false, tracingEnabled: false, videoEnabled: false, apiStepRecorder: false,
        bindingId: grok.bindingId, routineConfigured: true, routineUiVisible: true, humanSubmittedSecurely: true, storageClean };
    }
    if(input.mode === "personal-secret-create"){
      const personal=input.personal,setup=new URL(input.setupURL);
      if (personal?.viaMySecrets !== undefined && typeof personal.viaMySecrets !== 'boolean') throw new Error('Invalid finite personal secret navigation');
      if(!input.companyId||!/^[a-f0-9-]{36}$/i.test(input.companyId)||!personal||!/^[a-f0-9-]{36}$/i.test(personal.definitionId)||!personal.userId||personal.userId.length>160||!setup.pathname.endsWith('/company/settings/secrets')||(personal.viaMySecrets ? setup.search!=='' : setup.searchParams.get('definition')!==personal.definitionId))throw new Error('Invalid finite personal secret operation');
      if (!personal.viaMySecrets) await page.goto(input.setupURL,{waitUntil:'domcontentloaded'});
      const session=await context.request.get('/api/auth/get-session');if(!session.ok()||(await session.json()).user?.id!==personal.userId)throw new Error('Personal secret human identity mismatch');
      const companyResponse = await context.request.get(`/api/companies/${input.companyId}`);
      const company = companyResponse.ok() ? await companyResponse.json() as { id: string; issuePrefix: string } : null;
      if (company?.id !== input.companyId || setup.pathname !== `/${company.issuePrefix}/company/settings/secrets`) throw new Error('Personal secret company navigation mismatch');
      const own=await context.request.get(`/api/companies/${input.companyId}/me/user-secrets`);if(!own.ok())throw new Error('Personal definition not readable');
      const entries=await own.json() as Array<{definition:{id:string;key:string;name:string};secret:unknown}>;const entry=entries.find(row=>row.definition.id===personal.definitionId);if(!entry||entry.definition.key!=='PERSONAL_PUBLISHING_KEY'||entry.secret)throw new Error('Personal definition already configured or mismatched');
      if (personal.viaMySecrets) {
        const settings = new URL(setup); settings.pathname = settings.pathname.replace(/\/secrets$/, '');
        await page.goto(settings.href,{waitUntil:'domcontentloaded'});
        await page.getByRole('link',{name:'Secrets',exact:true}).filter({visible:true}).click();
        await page.getByRole('tab',{name:'My secrets',exact:true}).click();
        await page.getByRole('listitem').filter({hasText:entry.definition.key}).getByRole('button',{name:'Set value',exact:true}).click();
      } else await page.getByRole('button',{name:'Set my value',exact:true}).click();
      const dialog=page.getByRole('dialog');await dialog.getByRole('heading',{name:/^Set your value/}).waitFor();
      if(!await dialog.getByText('Personal publishing credential',{exact:true}).isVisible())throw new Error('Wrong personal credential form');
      await dialog.getByRole('textbox').fill(input.credential);
      const created=page.waitForResponse(response=>new URL(response.url()).pathname===`/api/companies/${input.companyId}/me/user-secrets`&&response.request().method()==='POST'&&response.status()===201);
      await dialog.getByRole('button',{name:'Save value',exact:true}).click();const secret=await(await created).json() as {id:string;ownerUserId:string;userSecretDefinitionId:string};
      if(!/^[a-f0-9-]{36}$/i.test(secret.id)||secret.ownerUserId!==personal.userId||secret.userSecretDefinitionId!==personal.definitionId)throw new Error('Personal value owner/definition mismatch');await dialog.waitFor({state:'hidden'});
      const storageClean=await page.evaluate(value=>!JSON.stringify([Object.entries(localStorage),Object.entries(sessionStorage),document.body.innerText,location.href]).includes(value),input.credential);
      return {processIsolation:true,testRunnerAttached:false,tracingEnabled:false,videoEnabled:false,apiStepRecorder:false,secretId:secret.id,secretUiVisible:true,humanSubmittedSecurely:true,storageClean};
    }
    if(input.mode === "company-secret-create"){
      if(!input.companyId||!/^[a-f0-9-]{36}$/i.test(input.companyId)||!new URL(input.setupURL).pathname.endsWith("/company/settings/secrets"))throw new Error("Invalid finite company secret operation");
      await page.goto(input.setupURL,{waitUntil:"domcontentloaded"});await page.getByRole("button",{name:"New secret",exact:true}).click();
      const dialog=page.getByRole("dialog");await dialog.getByLabel("Name",{exact:true}).fill("Deployment API key");
      await dialog.getByLabel("Provider",{exact:true}).selectOption("local_encrypted");
      await dialog.getByLabel("Value",{exact:true}).fill(input.credential);
      const created=page.waitForResponse(response=>new URL(response.url()).pathname===`/api/companies/${input.companyId}/secrets`&&response.request().method()==="POST"&&response.status()===201);
      await dialog.getByRole("button",{name:"Create secret",exact:true}).click();const secret=await(await created).json() as {id:string};
      if(!/^[a-f0-9-]{36}$/i.test(secret.id))throw new Error("Invalid created secret identity");await dialog.waitFor({state:"hidden"});
      await page.getByText("Deployment API key",{exact:true}).first().waitFor();
      const storageClean=await page.evaluate(secret=>!JSON.stringify([Object.entries(localStorage),Object.entries(sessionStorage),document.body.innerText,location.href]).includes(secret),input.credential);
      return {processIsolation:true,testRunnerAttached:false,tracingEnabled:false,videoEnabled:false,apiStepRecorder:false,secretId:secret.id,secretUiVisible:true,humanSubmittedSecurely:true,storageClean};
    }
    if (input.mode === "gateway-token-rotation") {
      const g = input.gateway;
      if (!g || !/^[a-f0-9-]{36}$/i.test(g.id) || !/^[a-f0-9-]{36}$/i.test(g.oldTokenId) || !g.otherToken || g.otherToken.length > 8192 || !g.readName || g.readName.length > 240) throw new Error("Invalid finite gateway rotation request");
      const setup = new URL(input.setupURL), endpoint = new URL(g.endpointPath, base.origin);
      if (!setup.pathname.endsWith(`/apps/gateways/${g.id}/tokens`) || endpoint.origin !== base.origin || !/^\/mcp\/gateways\/[^/]+$|^\/api\/tool-gateway\/gateways\/[^/]+\/mcp$/.test(endpoint.pathname)) throw new Error("Invalid gateway UI/protocol boundary");
      async function discover(token: string) {
        const response = await fetch(endpoint, { method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000), headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/list",params:{}}) });
        const status = response.status; if (!response.ok) { await response.body?.cancel(); return { status, ok: false }; }
        const body = await response.json() as {result?: {tools?: Array<{name: string}>}}; return {status, ok: body.result?.tools?.some(tool => tool.name === g!.readName) === true};
      }
      await page.goto(input.setupURL, {waitUntil:"domcontentloaded"});
      await page.getByRole("button", {name:"Issue token",exact:true}).click();
      await page.getByRole("textbox", {name:/^Token name/}).fill("Replacement test client");
      const issued = page.waitForResponse(response => new URL(response.url()).pathname === `/api/tool-gateway/gateways/${g.id}/tokens` && response.request().method() === "POST" && response.status() === 201);
      await page.locator("form").getByRole("button", {name:"Issue token",exact:true}).click();
      const replacement = await (await issued).json() as {id: string; token: string};
      if (!/^[a-f0-9-]{36}$/i.test(replacement.id) || typeof replacement.token !== "string" || !replacement.token || replacement.token.length > 8192) throw new Error("Invalid one-time token");
      await page.getByText("New token — copy now", {exact:true}).waitFor();
      if (!await page.locator("code").filter({hasText:replacement.token}).count()) throw new Error("One-time token was not visibly delivered");
      const newWorkedBeforeRevocation = (await discover(replacement.token)).ok, oldWorkedUntilRevocation = (await discover(input.credential)).ok;
      if (!newWorkedBeforeRevocation || !oldWorkedUntilRevocation) throw new Error("Replacement must work before retiring old credential");
      await page.getByRole("button", {name:"Dismiss new token",exact:true}).click();
      const oldRow = page.getByRole("row").filter({has:page.getByText("Old test client", {exact:true})});
      if (!await oldRow.isVisible()) await page.getByRole("button", {name:/Token history/}).click();
      await oldRow.getByRole("button", {name:"Revoke",exact:true}).click();
      const dialog = page.getByRole("dialog"); await dialog.getByLabel("Type the token name to confirm", {exact:true}).fill("Old test client");
      const revoked = page.waitForResponse(response => new URL(response.url()).pathname === `/api/tool-gateway/gateway-tokens/${g.oldTokenId}/revoke` && response.request().method() === "POST" && response.ok());
      await dialog.getByRole("button", {name:"Revoke token",exact:true}).click(); await revoked; await dialog.waitFor({state:"hidden"});
      const old = await discover(input.credential), fresh = await discover(replacement.token), other = await discover(g.otherToken);
      await writeFile(path.join(path.dirname(process.argv[2]!), "token.json"), JSON.stringify({id:replacement.id,token:replacement.token}), {mode:0o600});
      return {processIsolation:true,testRunnerAttached:false,tracingEnabled:false,videoEnabled:false,apiStepRecorder:false,newTokenId:replacement.id,tokenUiVisible:true,newWorkedBeforeRevocation,oldWorkedUntilRevocation,oldRevoked:true,newWorksAfter:fresh.ok,oldStatusAfter:old.status,otherWorksAfter:other.ok};
    }
    await page.goto(input.setupURL, { waitUntil: "domcontentloaded" });
    await page.getByRole("textbox", { name: "MCP server URL", exact: true }).fill(input.providerURL); await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByRole("button", { name: "Check link", exact: true }).click();
    const key = page.getByLabel("App key", { exact: true }); await key.waitFor({ state: "visible" });
    const passwordInput = await key.getAttribute("type") === "password", autocompleteOff = await key.getAttribute("autocomplete") === "off";
    await key.fill(input.credential);
    const created = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/tools/apps/connect") && response.request().method() === "POST" && response.status() === 201);
    await page.getByRole("button", { name: "Check link", exact: true }).click();
    const connectionId = (await (await created).json() as { connectionId: string }).connectionId;
    if (!/^[a-f0-9-]{36}$/i.test(connectionId)) throw new Error("Secure setup did not return a bounded connection identity");
    await page.getByRole("heading", { name: /is ready\./i }).waitFor({ state: "visible" });
    const storageClean = await page.evaluate(secret => !JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage), location.href]).includes(secret), input.credential);
    await page.getByRole("button", { name: "View connection", exact: true }).click(); await key.waitFor({ state: "detached" });
    return { processIsolation: true, testRunnerAttached: false, tracingEnabled: false, videoEnabled: false, apiStepRecorder: false, connectionId, challengeVisible: true, passwordInput, autocompleteOff, humanSubmittedSecurely: true, visibleReady: true, storageClean };
  } finally { await browser.close(); }
}
main().then(receipt => process.stdout.write(JSON.stringify(receipt))).catch(() => { process.stderr.write("Private browser operation failed; diagnostics withheld"); process.exitCode = 1; });
