export default class ImportReport {
  onTestRunEnd(testModules) {
    const self = new Map();
    const files = [];
    for (const testModule of testModules) {
      const diagnostic = testModule.diagnostic();
      const durations = diagnostic.importDurations ?? {};
      let fileSelf = 0;
      for (const [id, value] of Object.entries(durations)) {
        const row = self.get(id) ?? { self: 0, count: 0 };
        row.self += value.selfTime; row.count++; self.set(id, row);
        fileSelf += value.selfTime;
      }
      files.push([testModule.moduleId, fileSelf, diagnostic.duration, diagnostic.prepareDuration, diagnostic.environmentSetupDuration, diagnostic.collectDuration, diagnostic.setupDuration]);
    }
    const shorten = id => id.replace(/^.*?\/paperclip\//, "");
    console.log("[import-report] top modules by summed self time (ms, count)");
    for (const [id, row] of [...self].sort((a, b) => b[1].self - a[1].self).slice(0, 60)) console.log(`[import-report] ${Math.round(row.self)} ${row.count} ${shorten(id)}`);
    console.log("[import-report] files by summed import self time (ms): self duration prepare env collect setup");
    for (const row of files.sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(`[import-report-file] ${row.slice(1).map(value => Math.round(value ?? -1)).join(" ")} ${shorten(row[0])}`);
    const totals = files.reduce((sum, row) => ({ self: sum.self + row[1], collect: sum.collect + (row[5] ?? 0), prepare: sum.prepare + (row[3] ?? 0), env: sum.env + (row[4] ?? 0), setup: sum.setup + (row[6] ?? 0) }), { self: 0, collect: 0, prepare: 0, env: 0, setup: 0 });
    console.log(`[import-report] totals ${JSON.stringify(totals)}`);
  }
}
