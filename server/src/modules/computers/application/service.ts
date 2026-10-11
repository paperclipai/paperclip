import { randomUUID } from "node:crypto";
import type { ComputerRepository, ComputerBackend } from "./ports.js";
import {
  ComputerError,
  ComputerStopPendingError,
  assertAdmission,
  exactOwner,
  expired,
  liveOwners,
  nextPort,
  isRunnerPort,
  segment,
  timeout,
  type ComputerRecord,
  type OwnerRef,
  type Owner,
} from "../domain/ledger.js";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";

// A terminal run can enqueue its successor before remote teardown has finished.
// Keep the incumbent owner fenced until its own cleanup or warm handoff settles.
class ComputerSessionBusyError extends ComputerError {
  constructor(readonly runId: string | undefined, readonly agentId: string | undefined) {
    super("conflict", "Computer session already has an active turn");
  }
}

// This is shutdown time only; admission and ordinary work stop at the warm deadline.
const RETIREMENT_GRACE_MS = 30_000;
const FILE_OPERATION_BUDGET_MS = 120_000;
const FILE_OPERATION_SETTLEMENT_MS = 5000;
type Scope = { companyId: string; environmentId: string };
export function createComputerService(
  repository: ComputerRepository,
  backend: ComputerBackend,
  now: () => Date = () => new Date(),
  options: {
    admissionWaitMs?: number;
    wait?: (ms: number) => Promise<void>;
  } = {},
) {
  const ref = (record: ComputerRecord, owner: Owner): OwnerRef => ({
    computerId: record.id,
    ownerId: owner.id,
    generation: owner.generation,
  });
  const retirements = new Map<string, Promise<{ retired: boolean }>>();
  const retirementGraceOpen = (owner: Owner) => owner.phase === "retiring" &&
    !!owner.retirementDeadline && Date.parse(owner.retirementDeadline) > now().getTime();
  const warmShutdownGraceOpen = (owner: Owner) => owner.kind === "runner" && owner.phase === "warm" &&
    !!owner.deadline && Date.parse(owner.deadline) + RETIREMENT_GRACE_MS > now().getTime();
  const processControlAllowed = (owner: Owner) =>
    ((owner.phase === "active" || owner.phase === "starting") && !expired(owner, now())) ||
    (owner.phase === "warm" && (!expired(owner, now()) || warmShutdownGraceOpen(owner))) ||
    retirementGraceOpen(owner);
  const base = (record: ComputerRecord) =>
    `/home/user/paperclip/${segment(record.companyId)}`;
  async function admitRecord<T>(
    scope: Scope,
    change: (record: ComputerRecord) => T,
    pendingStopRunId?: string,
  ): Promise<T> {
    const attempts = Math.ceil((options.admissionWaitMs ?? 120_000) / 1000);
    const wait =
      options.wait ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    for (let attempt = 0; ; attempt++) {
      try {
        return await repository.update(scope, (record) => {
          assertAdmission(record.ledger);
          return change(record);
        });
      } catch (error) {
        if (
          !(error instanceof ComputerError) ||
          error.code !== "conflict"
        )
          throw error;
        const current = await repository.get(scope);
        if (current.ledger.status !== "attached") throw error;
        if (error instanceof ComputerSessionBusyError && error.runId && error.agentId) {
          if (attempt >= attempts) throw error;
          // A terminal database status does not prove the process has stopped.
          // Wait for the existing owner transition; never retire it here or
          // advance its generation while final commands might still run.
          if (await repository.runState(scope, error.runId, error.agentId) !== "terminal") throw error;
          await wait(1000);
          continue;
        }
        if (!current.ledger.action) throw error;
        if (pendingStopRunId && current.ledger.action.providerStopId) {
          const action = current.ledger.action;
          const stop = await backend.stopStatus(current, action.providerStopId!);
          const latest = await repository.get(scope);
          if (stop.id === action.providerStopId && stop.status === "pending" &&
              latest.ledger.status === "attached" && latest.ledger.action?.id === action.id &&
              latest.ledger.action.providerStopId === stop.id) {
            throw new ComputerStopPendingError({ ...scope, computerId: current.id, stopId: stop.id, runId: pendingStopRunId });
          }
        }
        if (attempt >= attempts) throw error;
        await reconcileRecord(current);
        if ((await repository.get(scope)).ledger.action) await wait(1000);
      }
    }
  }
  async function scoped(input: Scope & { owner: OwnerRef }) {
    const record = await repository.get(input);
    return { record, owner: exactOwner(record, input.owner) };
  }
  async function inspect(input: Scope) {
    const record = await repository.get(input);
    const status = await backend.inspect(record);
    return {
      computerId: record.id,
      sandboxId: record.providerId,
      status: record.ledger.status,
      state: status.state,
    };
  }
  async function attach(
    input: Scope & {
      sandboxId: string;
      apiKeySecretRef: {
        type: "secret_ref";
        secretId: string;
        version?: number | "latest";
      };
    },
  ) {
    segment(input.companyId);
    segment(input.environmentId);
    segment(input.sandboxId);
    segment(input.apiKeySecretRef.secretId);
    let record: ComputerRecord;
    try {
      record = await repository.get(input);
      if (record.providerId !== input.sandboxId)
        throw new ComputerError(
          "conflict",
          "Environment already attaches another computer",
        );
    } catch (error) {
      if (!(error instanceof ComputerError) || error.code !== "not_found")
        throw error;
      record = {
        id: randomUUID(),
        companyId: input.companyId,
        environmentId: input.environmentId,
        providerId: input.sandboxId,
        ledger: {
          controllerId: randomUUID(),
          status: "attaching",
          secretRef: input.apiKeySecretRef,
          owners: [],
          placements: {},
          action: null,
        },
      };
      await repository.create(record);
    }
    if (
      JSON.stringify(record.ledger.secretRef) !==
      JSON.stringify(input.apiKeySecretRef)
    ) {
      const candidate = structuredClone(record);
      candidate.ledger.secretRef = input.apiKeySecretRef;
      const status = await backend.inspect(candidate);
      if (!status.snapshots)
        throw new ComputerError(
          "invalid",
          "Boat snapshots must remain enabled",
        );
      await repository.update(input, (current) => {
        current.ledger.secretRef = input.apiKeySecretRef;
      });
      record = candidate;
    }
    if (record.ledger.status === "detaching" || record.ledger.action)
      throw new ComputerError("conflict", "Computer cleanup is pending");
    if (record.ledger.status !== "attached") {
      await backend.ready(record);
      await backend.claim(record);
      await repository.update(input, (current) => {
        if (
          current.ledger.status === "attaching" ||
          current.ledger.status === "detached"
        )
          current.ledger.status = "attached";
      });
    }
    return { computerId: record.id };
  }
  async function binding(record: ComputerRecord, owner: Owner) {
    const ownerRef = ref(record, owner);
    const placement = record.ledger.placements[owner.sessionKey!];
    if (!placement)
      throw new ComputerError("conflict", "Computer placement is missing");
    const raw = await backend.runner(record);
    const control = await backend.runner(record, { control: true });
    let pinnedProcess = owner.process ? structuredClone(owner.process) : null;
    async function processScope() {
      if (!pinnedProcess) {
        const current = await scoped({ ...record, owner: ownerRef });
        if (!["active", "starting", "warm"].includes(current.owner.phase) || expired(current.owner, now()))
          throw new ComputerError("conflict", "Computer process capability has expired");
        return current;
      }
      const latest = await repository.get(record);
      const candidate = latest.ledger.owners.find(
        (value) => value.id === owner.id,
      );
      if (
        !candidate?.process ||
        !processControlAllowed(candidate) ||
        candidate.process.nonce !== pinnedProcess.nonce ||
        candidate.process.unitName !== pinnedProcess.unitName ||
        candidate.process.bootId !== pinnedProcess.bootId ||
        candidate.process.launchGeneration !== pinnedProcess.launchGeneration
      ) {
        throw new ComputerError(
          "conflict",
          "Computer process capability has expired",
        );
      }
      return { record: latest, owner: candidate };
    }
    const runnerFor = (
      processScoped: boolean,
    ): CommandManagedRuntimeRunner => ({
      execute: async (input) => {
        const current = await (processScoped
          ? processScope()
          : scoped({ ...record, owner: ownerRef }));
        if ((!["active", "starting", "warm"].includes(current.owner.phase) || expired(current.owner, now())) &&
            !(processScoped && pinnedProcess && processControlAllowed(current.owner)))
          throw new ComputerError("conflict", "Computer owner is retired");
        // Start a command unit under the same owner slice while holding the remote tombstone lock.
        // The lock is released only after systemd knows the unit, so retirement cannot miss a delayed launch.
        return (processScoped ? control : raw).execute({
          command: "python3",
          args: [
            "-c",
            String.raw`
import os,sys,json,fcntl,subprocess,time,tempfile,shutil
p=json.load(sys.stdin);os.umask(0o077);root='/home/user/.paperclip-owners/'+p['owner'];os.makedirs(root,exist_ok=True)
# A receipt reports foreground completion independently from cgroup lifetime.
# ExitType=cgroup keeps nohup/setsid descendants owned until owner retirement.
supervisor="""
import os,sys,json,subprocess
payload=sys.argv[1]
with open(payload) as f:p=json.load(f)
os.unlink(payload)
i=p['input']
try:
 with open(p['stdin'],'rb') as source:
  # Boat's persistent filesystem invalidates unlinked stdin descriptors.
  # Keep the private backing file until the command's normal finally cleanup.
  child=subprocess.Popen([i['command']]+i.get('args',[]),stdin=source)
  code=child.wait()
except Exception as error:
 print(str(error),file=sys.stderr);code=127
with open(p['receipt']+'.tmp','w') as f:json.dump({'exitCode':code},f)
os.replace(p['receipt']+'.tmp',p['receipt'])
"""
work=None
try:
 with open(root+'/lock','a') as lock:
  fcntl.flock(lock,fcntl.LOCK_EX)
  if os.path.exists(root+'/retired'):raise RuntimeError('computer owner retired')
  if os.path.exists(root+'/retiring.json'):
   with open(root+'/retiring.json') as retirement:deadline=json.load(retirement)['deadline']
   if not p.get('processClaim') or time.time()*1000>=deadline:raise RuntimeError('computer owner is retiring')
  if p.get('processClaim'):
   claim=json.load(open(root+'/claim.json'))
   if any(claim[k]!=p['processClaim'][k] for k in ['nonce','unitName','bootId','launchGeneration']) or claim['bootId']!=open('/proc/sys/kernel/random/boot_id').read().strip():raise RuntimeError('computer process superseded')
  elif not os.path.exists(root+'/generation') or int(open(root+'/generation').read())!=p['generation']:raise RuntimeError('computer owner superseded')
  work=tempfile.mkdtemp(prefix='command-',dir=root)
  output=work+'/stdout';error=work+'/stderr';receipt=work+'/receipt';payload=work+'/input.json';source=work+'/stdin'
  for path in [output,error,source]:open(path,'wb').close()
  i=p['input']
  with open(source,'w') as f:f.write(i.get('stdin',''))
  with open(payload,'w') as f:json.dump({'input':i,'stdin':source,'receipt':receipt},f)
  args=['systemd-run','--user','--quiet','--collect','--unit='+p['unit'],'--slice=paperclip-'+p['owner']+'.slice','--property=Type=exec','--property=ExitType=cgroup','--property=KillMode=control-group','--property=StandardOutput=append:'+output,'--property=StandardError=append:'+error,'--working-directory='+i.get('cwd',p['cwd'])]
  for k,v in i.get('env',{}).items():args.append('--setenv='+k+'='+v)
  started=subprocess.run(args+['--','python3','-c',supervisor,payload],capture_output=True,text=True)
  if started.returncode:sys.stderr.write(started.stderr);sys.exit(started.returncode)
 with open(output,'rb') as out,open(error,'rb') as err:
  while True:
   done=os.path.exists(receipt)
   for stream,dest in [(out,sys.stdout.buffer),(err,sys.stderr.buffer)]:
    chunk=stream.read()
    if chunk:dest.write(chunk);dest.flush()
   if done:break
   state=subprocess.run(['systemctl','--user','show',p['unit'],'--property=ActiveState','--value'],capture_output=True,text=True).stdout.strip()
   if state not in ('active','activating','reloading'):
    if os.path.exists(receipt):continue
    raise RuntimeError('computer command stopped before completion')
   time.sleep(.05)
 with open(receipt) as f:code=json.load(f)['exitCode']
 sys.exit(code if code>=0 else 128-code)
finally:
 if work:shutil.rmtree(work,ignore_errors=True)
`,
          ],
          stdin: JSON.stringify({
            owner: owner.id,
            generation: current.owner.generation,
            processClaim: processScoped ? pinnedProcess : null,
            unit: `paperclip-command-${randomUUID()}.service`,
            cwd: placement.cwd,
            input: {
              command: input.command,
              args: input.args,
              cwd: input.cwd,
              env: input.env,
              stdin: input.stdin,
            },
          }),
          timeoutMs: input.timeoutMs,
          onLog: input.onLog,
          onSpawn: input.onSpawn,
        });
      },
    });
    return {
      owner: ownerRef,
      runner: runnerFor(false),
      computerTool: backend.computerTool(),
      process: {
        runner: runnerFor(true),
        async ingress(input?: { port?: number; path?: string }) {
          const current = await processScope();
          return backend.ingress(
            current.record,
            input?.port ?? current.owner.port,
            input?.path ?? "/",
          );
        },
      },
      listenerPort: owner.port,
      remoteCwd: placement.cwd,
      agentHome: placement.root,
      placementId: placement.id,
      async launch(input: {
        command: string;
        args?: string[];
        cwd?: string;
        env?: Record<string, string>;
      }) {
        const before = await scoped({ ...record, owner: ownerRef });
        const existing = before.owner.process
          ? await backend.inspectProcess(before.record, before.owner)
          : null;
        const claimed = await repository.update(record, (current) => {
          const o = exactOwner(current, ownerRef);
          if (o.phase !== "active" && o.phase !== "starting")
            throw new ComputerError("conflict", "Computer owner cannot launch");
          if (existing?.running && existing.claim) o.process = existing.claim;
          else if (!o.process || !existing?.running)
            o.process = {
              bootId: "",
              unitName: `paperclip-${o.id}.service`,
              nonce: randomUUID(),
              launchGeneration: (o.process?.launchGeneration ?? 0) + 1,
            };
          return structuredClone(current);
        });
        const claim = await backend.launch(
          claimed,
          exactOwner(claimed, ownerRef),
          input,
        );
        await repository.update(record, (current) => {
          exactOwner(current, ownerRef).process = claim;
        });
        pinnedProcess = structuredClone(claim);
        return claim;
      },
      async inspectProcess() {
        const current = await scoped({ ...record, owner: ownerRef });
        return backend.inspectProcess(current.record, current.owner);
      },
      async ingress(input?: { port?: number; path?: string }) {
        const current = await scoped({ ...record, owner: ownerRef });
        if (!["active", "starting", "warm"].includes(current.owner.phase) || expired(current.owner, now()))
          throw new ComputerError("conflict", "Computer owner retired");
        return backend.ingress(
          current.record,
          input?.port ?? owner.port,
          input?.path ?? "/",
        );
      },
    };
  }
  async function admit(
    input: Scope & {
      agentId?: string;
      runId?: string;
      probeId?: string;
      sessionKey: string;
      idleTimeoutMs: number;
      deferPendingStop?: boolean;
    },
  ) {
    if (input.agentId) segment(input.agentId);
    if (!input.agentId && !input.probeId)
      throw new ComputerError("invalid", "A computer run requires an agent");
    if ((!input.runId && !input.probeId) || (input.runId && input.probeId))
      throw new ComputerError(
        "invalid",
        "Computer admission requires one run or probe identity",
      );
    if (input.probeId) segment(input.probeId);
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(input.sessionKey))
      throw new ComputerError("invalid", "Invalid computer session key");
    timeout(input.idleTimeoutMs);
    const result = await admitRecord(input, (record) => {
      let owner = record.ledger.owners.find(
        (o) =>
          o.kind === "runner" &&
          o.agentId === input.agentId &&
          o.sessionKey === input.sessionKey &&
          o.phase !== "retired",
      );
      if (owner && owner.phase !== "warm")
        throw new ComputerSessionBusyError(owner.runId, owner.agentId);
      if (owner && expired(owner, now()))
        throw new ComputerSessionBusyError(owner.runId, owner.agentId);
      if (owner) {
        owner.generation++;
        owner.phase = "starting";
        owner.runId = input.runId;
        owner.admittedAt = now().toISOString();
        owner.deadline = new Date(now().getTime() + 120_000).toISOString();
      } else {
        owner = {
          id: randomUUID(),
          generation: 1,
          kind: "runner",
          phase: "starting",
          agentId: input.agentId,
          runId: input.runId,
          probeId: input.probeId,
          admittedAt: now().toISOString(),
          sessionKey: input.sessionKey,
          port: nextPort(record.ledger.owners),
          deadline: new Date(now().getTime() + 120_000).toISOString(),
          absoluteDeadline: null,
          process: null,
        };
        record.ledger.owners.push(owner);
      }
      const agentHome = input.agentId
        ? `${base(record)}/agents/${input.agentId}`
        : `${base(record)}/probes/${input.probeId}`;
      if (input.agentId) {
        record.ledger.placements[input.agentId] ??= {
          id: randomUUID(),
          root: agentHome,
          cwd: agentHome,
        };
      }
      record.ledger.placements[input.sessionKey] ??= {
        id: randomUUID(),
        root: agentHome,
        cwd: input.probeId
          ? `${base(record)}/probes/${input.probeId}`
          : agentHome,
      };
      return { record: structuredClone(record), owner: structuredClone(owner) };
    }, input.deferPendingStop ? input.runId : undefined);
    await backend.ready(result.record);
    await backend.claim(result.record);
    if (result.owner.generation === 1 && !result.owner.process) {
      const availability = await backend.runnerPorts(result.record);
      const allocated = await repository.update(input, (record) => {
        const owner = exactOwner(record, ref(result.record, result.owner));
        if (owner.phase !== "starting")
          throw new ComputerError("conflict", "Computer admission was retired");
        owner.port = nextPort(record.ledger.owners.filter((other) => other.id !== owner.id), availability);
        return { record: structuredClone(record), owner: structuredClone(owner) };
      });
      result.record = allocated.record;
      result.owner = allocated.owner;
    }
    await backend.advance(result.record, result.owner);
    await backend.renew(result.record);
    if (input.probeId) {
      // Readiness commands run before managed-home preparation. Give them an
      // existing workspace without creating the personal home: an absent home
      // must remain eligible for the first atomic managed-file seed.
      await backend.remote(result.record, {
        action: "seed",
        root: result.record.ledger.placements[input.sessionKey]!.cwd,
        files: {},
      });
    }
    const active = await repository.update(input, (record) => {
      const owner = exactOwner(record, ref(result.record, result.owner));
      if (owner.phase !== "starting")
        throw new ComputerError("conflict", "Computer admission was retired");
      owner.phase = "active";
      owner.deadline = owner.probeId
        ? new Date(
            now().getTime() + Math.min(input.idleTimeoutMs, 120_000),
          ).toISOString()
        : null;
      return { record: structuredClone(record), owner: structuredClone(owner) };
    });
    return binding(active.record, active.owner);
  }
  async function recover(input: Scope & { owner: OwnerRef }) {
    const { record, owner } = await scoped(input);
    if (!["active", "warm"].includes(owner.phase) || expired(owner, now()))
      throw new ComputerError(
        "conflict",
        "Computer owner is no longer recoverable",
      );
    await backend.ready(record);
    await backend.claim(record);
    return binding(record, owner);
  }
  async function retainWarm(
    input: Scope & { owner: OwnerRef; idleTimeoutMs: number },
  ) {
    timeout(input.idleTimeoutMs);
    await repository.update(input, (record) => {
      const owner = exactOwner(record, input.owner);
      if (owner.kind !== "runner" || owner.probeId || owner.phase !== "active")
        throw new ComputerError(
          "conflict",
          "Computer owner cannot become warm",
        );
      owner.phase = "warm";
      owner.deadline = new Date(
        now().getTime() + input.idleTimeoutMs,
      ).toISOString();
    });
  }
  async function isRetired(input: Scope & { owner: OwnerRef; agentId: string; runId: string }) {
    const record = await repository.get(input);
    if (record.id !== input.owner.computerId) return false;
    return record.ledger.owners.some((owner) =>
      owner.id === input.owner.ownerId &&
      owner.generation === input.owner.generation &&
      owner.kind === "runner" &&
      owner.phase === "retired" &&
      owner.agentId === input.agentId &&
      owner.runId === input.runId,
    );
  }
  async function retire(input: Scope & { owner: OwnerRef; beforeStop?: () => Promise<void> }) {
    const key = `${input.companyId}:${input.environmentId}:${input.owner.computerId}:${input.owner.ownerId}:${input.owner.generation}`;
    const existing = retirements.get(key);
    if (existing) return existing;
    const pending = performRetirement(input);
    retirements.set(key, pending);
    try { return await pending; }
    finally { if (retirements.get(key) === pending) retirements.delete(key); }
  }
  async function performRetirement(input: Scope & { owner: OwnerRef; beforeStop?: () => Promise<void> }) {
    const state = await repository.update(input, (record) => {
      const owner = record.ledger.owners.find((value) => value.id === input.owner.ownerId);
      if (record.id !== input.owner.computerId || !owner)
        throw new ComputerError("not_found", "Computer owner not found");
      if (owner.generation !== input.owner.generation) return null;
      if (retirementGraceOpen(owner))
        throw new ComputerError("conflict", "Computer graceful retirement is pending");
      const retirementDeadline = owner.phase === "warm" && owner.deadline
        ? Math.min(now().getTime() + RETIREMENT_GRACE_MS, Date.parse(owner.deadline) + RETIREMENT_GRACE_MS)
        : now().getTime() + RETIREMENT_GRACE_MS;
      const graceful = owner.phase !== "retiring" && owner.phase !== "retired" &&
        owner.kind === "runner" && !!owner.process && !!input.beforeStop && retirementDeadline > now().getTime();
      if (owner.phase !== "retired") {
        owner.phase = "retiring";
        owner.retirementDeadline = graceful ? new Date(retirementDeadline).toISOString() : null;
      }
      return { record: structuredClone(record), owner: structuredClone(owner), graceful };
    });
    if (!state) return { retired: false };
    if (state.owner.phase === "retired") return { retired: true };
    if (state.graceful) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          (async () => {
            await backend.advance(state.record, state.owner);
            if (retirementGraceOpen(state.owner)) await input.beforeStop!();
          })(),
          new Promise<void>((resolve) => { timer = setTimeout(resolve, Math.max(0, Date.parse(state.owner.retirementDeadline!) - now().getTime())); }),
        ]);
      } catch {
        // Graceful provider shutdown is best effort; physical retirement is mandatory.
      } finally { if (timer) clearTimeout(timer); }
      await repository.update(input, (record) => {
        exactOwner(record, input.owner).retirementDeadline = null;
      });
    }
    if (state.owner.kind === "runner") {
      const status = await backend.inspect(state.record);
      if (!["stopped", "archived"].includes(status.state))
        await backend.retire(state.record, state.owner);
    }
    await repository.update(input, (record) => {
      const owner = exactOwner(record, input.owner);
      owner.phase = "retired";
      owner.deadline = null;
      owner.retirementDeadline = null;
    });
    return { retired: true };
  }
  async function connect(
    input: Scope & { userId: string; idleTimeoutMs: number },
  ) {
    timeout(input.idleTimeoutMs);
    const deadline = new Date(
      now().getTime() + input.idleTimeoutMs,
    ).toISOString();
    const data = await admitRecord(input, (record) => {
      const owner: Owner = {
        id: randomUUID(),
        generation: 1,
        kind: "viewer",
        phase: "active",
        userId: input.userId,
        port: 0,
        deadline,
        absoluteDeadline: deadline,
        process: null,
      };
      record.ledger.owners.push(owner);
      return { record: structuredClone(record), owner };
    });
    await backend.ready(data.record);
    await backend.claim(data.record);
    await backend.renew(data.record);
    const viewer = await backend.desktop(data.record);
    return {
      ...viewer,
      expiresAt: new Date(
        Math.min(Date.parse(viewer.expiresAt), Date.parse(deadline)),
      ).toISOString(),
      owner: ref(data.record, data.owner),
    };
  }
  async function renewViewer(
    input: Scope & { owner: OwnerRef; userId: string },
  ) {
    const { record, owner } = await scoped(input);
    if (owner.kind !== "viewer" || owner.userId !== input.userId)
      throw new ComputerError(
        "forbidden",
        "Computer viewer belongs to another user",
      );
    if (owner.phase !== "active" || expired(owner, now()))
      throw new ComputerError(
        "conflict",
        "Computer connection expired; connect again",
      );
    // Presence refreshes credentials; desktop readiness belongs to explicit Connect.
    const viewer = await backend.desktop(record, { checkInput: false });
    return {
      ...viewer,
      expiresAt: new Date(
        Math.min(
          Date.parse(viewer.expiresAt),
          Date.parse(owner.absoluteDeadline!),
        ),
      ).toISOString(),
      owner: input.owner,
    };
  }
  async function disconnectViewer(
    input: Scope & { owner: OwnerRef; userId: string },
  ) {
    const { owner } = await scoped(input);
    if (owner.kind !== "viewer" || owner.userId !== input.userId)
      throw new ComputerError(
        "forbidden",
        "Computer viewer belongs to another user",
      );
    await retire(input);
  }
  async function preview(input: Scope & { owner: OwnerRef; port: number }) {
    const { record, owner } = await scoped(input);
    if (
      owner.kind !== "runner" ||
      !["active", "warm"].includes(owner.phase) ||
      expired(owner, now())
    )
      throw new ComputerError("conflict", "Preview owner is not live");
    if (isRunnerPort(input.port))
      throw new ComputerError(
        "forbidden",
        "Runner ports are not application previews",
      );
    try {
      await backend.remote(record, {
        root: base(record),
        action: "owned-port",
        port: input.port,
        ownerId: owner.id,
      });
    } catch (error) {
      if (error instanceof ComputerError && error.code === "conflict") {
        throw new ComputerError("conflict", "No dev server is running on this port for this task. Start it in the task and try again.");
      }
      throw error;
    }
    return backend.preview(record, input.port);
  }
  async function withFiles<T>(
    input: Scope,
    root: string,
    fn: (record: ComputerRecord, deadlineMs: number) => Promise<T>,
  ): Promise<T> {
    const data = await admitRecord(input, (record) => {
      const deadlineMs = now().getTime() + FILE_OPERATION_BUDGET_MS;
      const owner: Owner = {
        id: randomUUID(),
        generation: 1,
        kind: "file-operation",
        phase: "active",
        port: 0,
        // Transport cancellation has a bounded settlement window; it is not
        // additional time in which commands may start or continue.
        deadline: new Date(deadlineMs + FILE_OPERATION_SETTLEMENT_MS).toISOString(),
        absoluteDeadline: null,
        process: null,
      };
      record.ledger.owners.push(owner);
      return { record: structuredClone(record), owner, deadlineMs };
    });
    const assertLive = async () => {
      if (now().getTime() >= data.deadlineMs)
        throw new ComputerError("provider_error", "Computer file operation timed out");
      const current = await repository.get(input);
      if (exactOwner(current, ref(data.record, data.owner)).phase !== "active")
        throw new ComputerError("conflict", "Computer file operation is no longer active");
    };
    try {
      await assertLive();
      await backend.ready(data.record, { deadlineMs: data.deadlineMs });
      await assertLive();
      await backend.claim(data.record, { deadlineMs: data.deadlineMs });
      await assertLive();
      return await fn(data.record, data.deadlineMs);
    } finally {
      await repository.update(input, (record) => {
        const owner = record.ledger.owners.find(
          (value) => value.id === data.owner.id,
        );
        if (owner?.phase === "active") {
          owner.phase = "warm";
          owner.deadline = new Date(Math.min(
            now().getTime() + FILE_OPERATION_SETTLEMENT_MS,
            data.deadlineMs + FILE_OPERATION_SETTLEMENT_MS,
          )).toISOString();
        }
      });
    }
  }
  function fileAccess(input: Scope, root: string) {
    const remote = (payload: Record<string, unknown>) =>
      withFiles(input, root, (record, deadlineMs) =>
        backend.remote(record, { ...payload, root }, { deadlineMs }),
      );
    const readBytes = async (
      path: string,
      maxBytes = 16 * 1024 * 1024,
    ): Promise<{ bytes: Buffer; sha256: string }> => {
      if (
        !Number.isSafeInteger(maxBytes) ||
        maxBytes < 0 ||
        maxBytes > 16 * 1024 * 1024
      )
        throw new ComputerError("invalid", "Invalid remote file size limit");
      const value = await remote({ action: "read", path, maxBytes });
      return {
        bytes: Buffer.from(value.base64, "base64"),
        sha256: value.sha256,
      };
    };
    const writeBytes = async (
      path: string,
      bytes: Buffer,
      expectedSha256: string | null,
    ): Promise<{ sha256: string }> =>
      remote({
        action: "write",
        path,
        base64: bytes.toString("base64"),
        expectedSha256,
      });
    const seedFiles = async (chunks: AsyncIterable<{ path: string; offset: number; bytes: Buffer }>): Promise<{ seeded: boolean }> => {
      const seedId = randomUUID();
      const started = await remote({ action: "seed-begin", seedId });
      if (!started.started) return { seeded: false };
      try {
        for await (const chunk of chunks) {
          if (chunk.bytes.length > 1024 * 1024) throw new ComputerError("invalid", "Initial home chunk exceeds its size limit");
          await remote({ action: "seed-chunk", seedId, path: chunk.path, offset: chunk.offset, base64: chunk.bytes.toString("base64") });
        }
        return await remote({ action: "seed-commit", seedId });
      } catch (error) {
        await remote({ action: "seed-abort", seedId }).catch(() => undefined);
        throw error;
      }
    };
    const seedBytes = async (files: Record<string, Buffer>): Promise<{ seeded: boolean }> => seedFiles((async function* () {
      for (const [path, bytes] of Object.entries(files)) {
        for (let offset = 0; offset < Math.max(1, bytes.length); offset += 1024 * 1024) {
          yield { path, offset, bytes: bytes.subarray(offset, offset + 1024 * 1024) };
        }
      }
    })());
    return {
      root,
      readBytes,
      seedFiles,
      seedBytes,
      writeBytes,
      async read(path: string) {
        const value = await readBytes(path);
        return { content: value.bytes.toString("utf8"), sha256: value.sha256 };
      },
      async write(
        path: string,
        content: string,
        expectedSha256: string | null,
      ) {
        return writeBytes(path, Buffer.from(content), expectedSha256);
      },
      async listPage(path = "", options: { limit?: number } = {}): Promise<{
        entries: Array<{ name: string; kind: "file" | "directory"; size: number; mtimeMs: number }>;
        truncated: boolean;
      }> {
        return remote({ action: "list", path, limit: options.limit ?? 1000 });
      },
      async list(path = "") {
        const page = await this.listPage(path);
        if (page.truncated) throw new ComputerError("invalid", "Computer directory exceeds the listing limit");
        return page.entries;
      },
      async stat(path: string): Promise<{ name: string; kind: "file" | "directory"; size: number; mtimeMs: number }> {
        return remote({ action: "stat", path });
      },
      async hash(path: string): Promise<{ sha256: string; size: number }> {
        return remote({ action: "hash", path });
      },
      async remove(path: string, expectedSha256: string) {
        await remote({ action: "remove", path, expectedSha256 });
      },
      async move(
        from: string,
        to: string,
        expectedSha256: string,
      ): Promise<{ sha256: string }> {
        return remote({ action: "move", path: from, to, expectedSha256 });
      },
      async seed(files: Record<string, string>): Promise<{ seeded: boolean }> {
        return seedBytes(Object.fromEntries(Object.entries(files).map(([path, content]) => [path, Buffer.from(content)])));
      },
    };
  }
  async function files(input: Scope & { agentId: string }) {
    segment(input.agentId);
    const placement = await admitRecord(input, (record) => {
      return (record.ledger.placements[input.agentId] ??= {
        id: randomUUID(),
        root: `${base(record)}/agents/${input.agentId}`,
        cwd: `${base(record)}/agents/${input.agentId}`,
      });
    });
    return fileAccess(input, placement.root);
  }
  async function workspaceFiles(input: Scope & { placementId: string }) {
    const record = await repository.get(input);
    const placement = Object.values(record.ledger.placements).find(
      (p) => p.id === input.placementId,
    );
    if (!placement)
      throw new ComputerError(
        "not_found",
        "Computer workspace placement not found",
      );
    return fileAccess(input, placement.cwd);
  }
  async function realizeWorkspace(
    input: Scope & {
      owner: OwnerRef;
      projectId?: string;
      taskId?: string;
      repositoryUrl?: string;
      /** Transient Git helper configuration; sent over stdin, never retained in the ledger. */
      gitAuth?: { configArgs: string[]; env: Record<string, string> };
      branch?: string;
      baseRef?: string;
      mode: "shared" | "worktree";
    },
  ) {
    const { record, owner } = await scoped(input);
    if (owner.phase !== "active" || (!owner.agentId && input.projectId))
      throw new ComputerError("conflict", "Workspace owner is not active");
    const placement = record.ledger.placements[owner.sessionKey!]!;
    if (!input.projectId)
      return {
        remoteCwd: placement.cwd,
        agentHome: placement.root,
        placementId: placement.id,
      };
    const root = `${base(record)}/projects/${segment(input.projectId)}`;
    if (input.taskId) segment(input.taskId);
    const result = await backend.remote(record, {
      ...input,
      root,
      action: "workspace",
    });
    await repository.update(input, (current) => {
      exactOwner(current, input.owner);
      const placementKey = `workspace:${owner.agentId}:${input.projectId}:${input.mode}:${input.taskId ?? "shared"}:${result.remoteCwd}`;
      current.ledger.placements[placementKey] ??= {
        id: randomUUID(),
        root: placement.root,
        cwd: result.remoteCwd,
      };
      current.ledger.placements[owner.sessionKey!] =
        current.ledger.placements[placementKey]!;
    });
    const updated = await repository.get(input);
    return {
      remoteCwd: result.remoteCwd as string,
      agentHome: placement.root,
      placementId: updated.ledger.placements[owner.sessionKey!]!.id,
    };
  }
  async function detach(input: Scope) {
    const record = await repository.update(input, (current) => {
      current.ledger.status = "detaching";
      return structuredClone(current);
    });
    for (const owner of liveOwners(record.ledger))
      await retire({ ...input, owner: ref(record, owner) });
    await reconcileRecord(await repository.get(input));
  }
  const reconciliation = new Map<string, Promise<void>>();
  async function reconcileRecord(record: ComputerRecord): Promise<void> {
    const existing = reconciliation.get(record.id);
    if (existing) return existing;
    const pending = (async () =>
      reconcileOwnedRecord(await repository.get(record)))();
    reconciliation.set(record.id, pending);
    try {
      await pending;
    } finally {
      if (reconciliation.get(record.id) === pending)
        reconciliation.delete(record.id);
    }
  }
  async function reconcileOwnedRecord(record: ComputerRecord) {
    if (record.ledger.status === "attaching") return;
    // A crash can happen after admission but before an environment lease exists.
    // Run identity, rather than lease presence, decides whether that active owner
    // still has work to recover. Warm owners keep their own idle deadline.
    for (const owner of liveOwners(record.ledger)) {
      const admittedAt = owner.admittedAt ? Date.parse(owner.admittedAt) : 0;
      if (
        owner.kind === "runner" &&
        owner.phase === "active" &&
        owner.runId &&
        owner.agentId &&
        now().getTime() - admittedAt >= 120_000
      ) {
        const runState = await repository.runState(
          record,
          owner.runId,
          owner.agentId,
        );
        if (runState !== "active")
          await retire({ ...record, owner: ref(record, owner) });
      }
    }
    record = await repository.get(record);
    for (const owner of liveOwners(record.ledger))
      if (owner.phase === "retiring" ? !retirementGraceOpen(owner)
          : expired(owner, now()) && !warmShutdownGraceOpen(owner))
        await retire({ ...record, owner: ref(record, owner) });
    await repository.update(record, (current) => {
      current.ledger.owners = current.ledger.owners.filter(
        // Only runner tombstones are needed for durable process-stop proof.
        (owner) => owner.kind === "runner" || owner.phase !== "retired",
      );
    });
    record = await repository.get(record);
    if (record.ledger.action) {
      const action = record.ledger.action;
      // A lost stop response is retried only while admission is fenced. Boat returns its same pending ID.
      let stop = action.providerStopId
        ? await backend.stopStatus(record, action.providerStopId)
        : await backend.stop(record);
      if (stop.status === "superseded") {
        // A provider-side resume can supersede the recorded stop. Keep admission
        // fenced until current physical state proves stopped or a replacement
        // normal snapshot operation completes; never force or delete the host.
        const current = await backend.inspect(record);
        if (["stopped", "archived"].includes(current.state)) {
          stop = { id: stop.id, status: "completed" };
        } else if (current.stop && current.stop.id !== stop.id &&
          ["pending", "failing"].includes(current.stop.status)) {
          stop = current.stop;
        } else {
          stop = await backend.stop(record);
        }
      }
      await repository.update(record, (current) => {
        if (current.ledger.action?.id !== action.id) return;
        current.ledger.action.providerStopId = stop.id;
        if (stop.status === "completed") {
          current.ledger.action = null;
          if (current.ledger.status === "detaching")
            current.ledger.status = "detached";
        }
      });
      return;
    }
    if (liveOwners(record.ledger).length) {
      await backend.renew(record);
      return;
    }
    if (record.ledger.status === "detached") return;
    const status = await backend.inspect(record);
    if (["stopped", "archived"].includes(status.state)) {
      if (record.ledger.status === "detaching")
        await repository.update(record, (current) => {
          current.ledger.status = "detached";
        });
      return;
    }
    const actionId = randomUUID();
    const claimed = await repository.update(record, (current) => {
      if (current.ledger.action || liveOwners(current.ledger).length)
        return false;
      current.ledger.action = {
        kind: "stop",
        id: actionId,
        providerStopId: null,
      };
      return true;
    });
    if (!claimed) return;
    const stop = await backend.stop(record);
    await repository.update(record, (current) => {
      if (current.ledger.action?.id === actionId)
        current.ledger.action.providerStopId = stop.id;
    });
  }
  async function reconcile() {
    const failures: unknown[] = [];
    for (const record of await repository.all())
      try {
        await reconcileRecord(record);
      } catch (error) {
        failures.push(error);
      }
    if (failures.length)
      throw new AggregateError(
        failures,
        "Computer reconciliation requires retry",
      );
  }
  return {
    async list(companyId: string) {
      return (await repository.all())
        .filter((record) => record.companyId === companyId)
        .map((record) => ({
          computerId: record.id,
          environmentId: record.environmentId,
          sandboxId: record.providerId,
          status: record.ledger.status,
        }));
    },
    attach,
    admit,
    admitProbe(
      input: Scope & {
        agentId?: string;
        probeId: string;
        idleTimeoutMs: number;
      },
    ) {
      return admit({ ...input, sessionKey: `probe-${segment(input.probeId)}` });
    },
    recover,
    retainWarm,
    isRetired,
    retire,
    connect,
    renewViewer,
    disconnectViewer,
    preview,
    files,
    workspaceFiles,
    realizeWorkspace,
    detach,
    reconcile,
    inspect,
  };
}
