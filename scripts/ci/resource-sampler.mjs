import { readFileSync } from "node:fs";

function readCpu() {
  const line = readFileSync("/proc/stat", "utf8").split("\n")[0].trim().split(/\s+/).slice(1).map(Number);
  const [user, nice, system, idle, iowait, irq, softirq, steal] = line;
  return { busy: user + nice + system + irq + softirq, idle, iowait, steal, total: line.reduce((a, b) => a + b, 0) };
}

function readMem() {
  const values = {};
  for (const line of readFileSync("/proc/meminfo", "utf8").split("\n")) {
    const match = /^(\w+):\s+(\d+)/.exec(line);
    if (match) values[match[1]] = Number(match[2]) / 1024;
  }
  return { totalMb: values.MemTotal, availableMb: values.MemAvailable, swapUsedMb: values.SwapTotal - values.SwapFree };
}

function readPressure(kind) {
  try {
    const some = readFileSync(`/proc/pressure/${kind}`, "utf8").split("\n")[0];
    return Number(/avg10=([\d.]+)/.exec(some)?.[1] ?? NaN);
  } catch {
    return NaN;
  }
}

function countProcesses(name) {
  try {
    return readFileSync("/proc/loadavg", "utf8").trim().split(/\s+/)[3] + (name ? "" : "");
  } catch {
    return "?";
  }
}

export function startResourceSampler(label, intervalMs = 10_000) {
  if (process.platform !== "linux" || process.env.GITHUB_ACTIONS !== "true") return () => {};
  const started = Date.now();
  let previous = readCpu();
  const samples = [];
  const sample = () => {
    try {
      const cpu = readCpu();
      const total = cpu.total - previous.total || 1;
      const mem = readMem();
      const record = {
        t: Math.round((Date.now() - started) / 1000),
        busy: (100 * (cpu.busy - previous.busy)) / total,
        iowait: (100 * (cpu.iowait - previous.iowait)) / total,
        steal: (100 * (cpu.steal - previous.steal)) / total,
        usedMb: mem.totalMb - mem.availableMb,
        availMb: mem.availableMb,
        swapMb: mem.swapUsedMb,
        psiCpu: readPressure("cpu"),
        psiMem: readPressure("memory"),
        psiIo: readPressure("io"),
        procs: countProcesses(),
      };
      previous = cpu;
      samples.push(record);
      console.log(`[ci-resources] ${label} t=${record.t}s busy=${record.busy.toFixed(0)}% iowait=${record.iowait.toFixed(1)}% steal=${record.steal.toFixed(1)}% used=${record.usedMb.toFixed(0)}MB avail=${record.availMb.toFixed(0)}MB swap=${record.swapMb.toFixed(0)}MB psi_cpu=${record.psiCpu} psi_mem=${record.psiMem} psi_io=${record.psiIo} procs=${record.procs}`);
    } catch {
      // Diagnostics never fail a test run.
    }
  };
  const timer = setInterval(sample, intervalMs);
  timer.unref();
  return () => {
    clearInterval(timer);
    sample();
    if (samples.length === 0) return;
    const avg = key => samples.reduce((sum, s) => sum + s[key], 0) / samples.length;
    const max = key => Math.max(...samples.map(s => s[key]));
    console.log(`[ci-resources-summary] ${label} samples=${samples.length} avg_busy=${avg("busy").toFixed(1)}% avg_iowait=${avg("iowait").toFixed(1)}% avg_steal=${avg("steal").toFixed(1)}% max_used=${max("usedMb").toFixed(0)}MB min_avail=${Math.min(...samples.map(s => s.availMb)).toFixed(0)}MB max_swap=${max("swapMb").toFixed(0)}MB avg_psi_cpu=${avg("psiCpu").toFixed(1)} max_psi_mem=${max("psiMem").toFixed(1)} avg_psi_io=${avg("psiIo").toFixed(1)}`);
  };
}
