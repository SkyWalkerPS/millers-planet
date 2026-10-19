import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { anyCheckFailed, checkAppPage, checkGpuLoad, checkStrayHeadlessChrome, printBrowserPaneReminder, printChecks, runMachineChecks, waitForQuietGpu } from './preflight.mjs';
import { applyShotSetup, selectShots, shotsForPhase } from './shots.mjs';
import { evidenceDirectory, openMillersPlanet, startMillersPlanetServer } from './target.mjs';
import { normaliseBenchmarkResult, pageExpression } from './page-results.mjs';
import { formatNumber, formatTable, summarise } from './stats.mjs';

const FRAME_BUDGET_MS = 16.6;
const runCount = Number(process.env.RUNS || 3);
const measuredFrameCount = Number(process.env.FRAMES || 300);
const warmupFrameCount = Number(process.env.WARMUP || 90);
const paced = process.env.UNPACED !== '1';
const pinnedScale = process.env.SCALE || null;
const spanP99LimitMs = Number(process.env.SPAN_P99_LIMIT_MS || 14);
const keepShotClockFrozen = process.env.TIME === 'frozen';

function chooseShots() {
  const requested = process.argv.slice(2).length ? process.argv.slice(2) : (process.env.SHOTS ? process.env.SHOTS.split(',').map((name) => name.trim()).filter(Boolean) : []);
  if (requested.length) return selectShots(requested);
  const phase = Number(process.env.PHASE || 2);
  const phaseShots = shotsForPhase(phase).filter((shot) => shot.kind === 'still' || shot.kind === 'freshLoad');
  const flagged = phaseShots.filter((shot) => shot.benchmarkByDefault);
  return flagged.length ? flagged : phaseShots;
}

let shots;
try {
  shots = chooseShots();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
const phase = Number(process.env.PHASE || Math.max(...shots.map((shot) => shot.phase)));

printBrowserPaneReminder();
const machine = await runMachineChecks({ framesMustBePaced: paced });
printChecks(machine.checks, 'Preflight');
if (anyCheckFailed(machine.checks)) {
  console.error('\nBENCH REFUSED TO RUN: a preflight check failed (see FAIL above). GPU numbers would not be trustworthy.');
  process.exit(2);
}

function summariseShotRun(normalised, integrityProblems, extra) {
  const passSummaries = Object.fromEntries(Object.entries(normalised.passMsByLabel).map(([label, values]) => {
    const summary = summarise(values);
    return [label, { p50: summary.p50, p99: summary.p99 }];
  }));
  const span = summarise(normalised.spanMs);
  return {
    span,
    framesOverBudget: normalised.spanMs.filter((value) => value > FRAME_BUDGET_MS).length,
    busy: summarise(normalised.busyMs),
    passes: passSummaries,
    scale: summarise(normalised.scale),
    interval: summarise(normalised.intervalMs),
    internal: normalised.internal,
    output: normalised.output,
    integrityProblems,
    ...extra,
  };
}

async function benchmarkShot(page, shot) {
  await applyShotSetup(page, shot);
  if (!keepShotClockFrozen) await page.evaluate('window.millersPlanet.freezeTime(null)');
  const timeoutMs = Math.max(120000, (measuredFrameCount + warmupFrameCount) * 200);
  const combined = await page.evaluate(pageExpression(`(async () => {
    const api = window.millersPlanet;
    const result = await api.benchmark({ frames: ${measuredFrameCount}, warmup: ${warmupFrameCount}, paced: ${paced} });
    const stats = api.stats();
    return { result, gpuErrors: stats.gpuErrors || [], pipelinesCreatedAfter: stats.pipelinesCreated, internalAfter: stats.internal || null };
  })()`), { timeoutMs });
  const normalised = normaliseBenchmarkResult(combined.result);
  if (!normalised.internal && combined.internalAfter) normalised.internal = combined.internalAfter;
  const integrityProblems = [];
  const notes = [];
  const usableSpans = normalised.spanMs.filter((value) => Number.isFinite(value) && value > 0);
  if (normalised.frameCount !== measuredFrameCount) integrityProblems.push(`asked for ${measuredFrameCount} frames, got ${normalised.frameCount} spans`);
  if (usableSpans.length !== normalised.frameCount) integrityProblems.push(`${normalised.frameCount - usableSpans.length} measured frame(s) have no GPU span (never timed)`);
  if (normalised.framesSubmitted !== null && normalised.framesTimed !== null) {
    if (normalised.framesSubmitted !== normalised.framesTimed) integrityProblems.push(`framesTimed ${normalised.framesTimed} != frames submitted ${normalised.framesSubmitted}`);
  } else {
    integrityProblems.push('benchmark() reported no frame counters (expected framesSubmitted or framesMeasured, and framesTimed)');
  }
  if (normalised.untimedFrames) integrityProblems.push(`benchmark() reports ${normalised.untimedFrames} untimed frame(s)`);
  if (Array.isArray(normalised.pipelinesCreated)) {
    const framesWithNewPipelines = normalised.pipelinesCreated.map((count, frame) => ({ count, frame })).filter((entry) => entry.count > 0);
    if (framesWithNewPipelines.length) integrityProblems.push(`pipelines were created after warm-up on ${framesWithNewPipelines.length} frame(s) (first: frame ${framesWithNewPipelines[0].frame}, ${framesWithNewPipelines[0].count} pipeline(s))`);
  } else if (typeof normalised.pipelinesCreated === 'number') {
    if (normalised.pipelinesCreated > 0) integrityProblems.push(`${normalised.pipelinesCreated} pipeline(s) were created after warm-up`);
  } else if (typeof combined.pipelinesCreatedAfter === 'number') {
    notes.push('benchmark() did not report pipelines per frame; only the last frame (stats().pipelinesCreated) was checked');
    if (combined.pipelinesCreatedAfter > 0) integrityProblems.push(`stats().pipelinesCreated is ${combined.pipelinesCreatedAfter} after the benchmark`);
  } else {
    integrityProblems.push('the page reported no pipelinesCreated count');
  }
  for (const gpuError of normalised.gpuErrors) if (!combined.gpuErrors.includes(gpuError)) combined.gpuErrors.push(gpuError);
  if (combined.gpuErrors.length) integrityProblems.push(`GPU errors: ${combined.gpuErrors.slice(0, 3).map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry))).join(' | ')}`);
  return { summary: summariseShotRun(normalised, integrityProblems, { notes }), raw: normalised };
}

const evidencePath = path.join(evidenceDirectory(), `${phase}-bench.json`);
const runs = [];
const server = await startMillersPlanetServer();
for (const warning of server.warnings) console.warn(`WARNING: ${warning}`);
let exitCode = 0;
try {
  console.log(`\nBenchmarking ${shots.map((shot) => shot.name).join(', ')} from ${server.description}`);
  console.log(`${runCount} fresh run(s), ${measuredFrameCount} measured frames after ${warmupFrameCount} warm-up frames, ${paced ? 'paced by requestAnimationFrame' : 'UNPACED (back to back)'}, render scale ${pinnedScale ? `pinned to ${pinnedScale}` : 'live (controller)'}`);
  for (let runNumber = 1; runNumber <= runCount; runNumber++) {
    const quietWait = process.env.WAIT_FOR_QUIET_GPU === '0' ? null : await waitForQuietGpu();
    const gpuLoad = await checkGpuLoad();
    const otherChrome = await checkStrayHeadlessChrome();
    const target = await openMillersPlanet({ server, query: pinnedScale ? { scale: pinnedScale } : {} });
    const run = { runNumber, quietGpuWait: quietWait, gpuLoadBefore: { status: gpuLoad.status, samples: gpuLoad.samples, detail: gpuLoad.detail }, otherHeadlessChromeBefore: { status: otherChrome.status, detail: otherChrome.detail }, shots: {} };
    try {
      const { checks: appChecks } = await checkAppPage(target.page, { viewport: target.viewport });
      if (anyCheckFailed(appChecks)) {
        printChecks(appChecks, `Run ${runNumber}: app checks`);
        console.error('\nBENCH REFUSED TO RUN: the app failed a preflight check (see FAIL above).');
        exitCode = 2;
        break;
      }
      for (const shot of shots) {
        try {
          run.shots[shot.name] = await benchmarkShot(target.page, shot);
        } catch (error) {
          run.shots[shot.name] = { error: error.message.split('\n')[0] };
        }
      }
      const pageErrors = target.page.pageErrors();
      run.pageErrors = pageErrors.map((event) => `[${event.kind}] ${event.text}`);
    } finally {
      await target.close();
    }
    runs.push(run);
    console.log(`\nRun ${runNumber} of ${runCount} (GPU busy before the run: ${gpuLoad.samples ? `${gpuLoad.medianPercent}%` : 'unknown'})`);
    if (otherChrome.status !== 'PASS') console.log(`  WARNING before this run: ${otherChrome.detail}`);
    const rows = shots.map((shot) => {
      const entry = run.shots[shot.name];
      if (!entry || entry.error) return [shot.name, 'ERROR', '', '', '', '', '', '', '', entry ? entry.error : 'not measured'];
      const summary = entry.summary;
      return [
        shot.name,
        formatNumber(summary.span.p50), formatNumber(summary.span.p95), formatNumber(summary.span.p99), formatNumber(summary.span.max),
        `${summary.framesOverBudget}/${summary.span.count}`,
        formatNumber(summary.busy.p99),
        `${formatNumber(summary.scale.min, 3)}/${formatNumber(summary.scale.p50, 3)}/${formatNumber(summary.scale.max, 3)}`,
        summary.internal ? summary.internal.join('x') : '-',
        summary.integrityProblems.length ? `FAIL: ${summary.integrityProblems.join('; ')}` : 'ok',
      ];
    });
    console.log(formatTable(['shot', 'span p50', 'p95', 'p99', 'max', `>${FRAME_BUDGET_MS}ms`, 'busy p99', 'scale min/med/max', 'internal', 'integrity'], rows, { rightAlignFrom: 1 }));
    for (const shot of shots) {
      const entry = run.shots[shot.name];
      if (!entry || entry.error) continue;
      const passText = Object.entries(entry.summary.passes).map(([label, values]) => `${label} ${formatNumber(values.p50)}/${formatNumber(values.p99)}`).join(', ');
      console.log(`  ${shot.name} per-pass exclusive ms (p50/p99): ${passText || 'none reported'}`);
      for (const note of entry.summary.notes) console.log(`  ${shot.name} note: ${note}`);
    }
    if (run.pageErrors.length) console.log(`  page errors in run ${runNumber}:\n${run.pageErrors.map((line) => `    ${line}`).join('\n')}`);
  }
} finally {
  await server.close();
}

if (exitCode === 2) process.exit(2);

const worstRows = [];
const worstByShot = {};
const failures = [];
for (const shot of shots) {
  const measuredRuns = runs.map((run) => run.shots[shot.name]).filter((entry) => entry && !entry.error);
  const erroredRuns = runs.filter((run) => run.shots[shot.name]?.error).map((run) => `run ${run.runNumber}: ${run.shots[shot.name].error}`);
  for (const message of erroredRuns) failures.push(`${shot.name} ${message}`);
  if (!measuredRuns.length) continue;
  const worst = {
    spanP50: Math.max(...measuredRuns.map((entry) => entry.summary.span.p50)),
    spanP95: Math.max(...measuredRuns.map((entry) => entry.summary.span.p95)),
    spanP99: Math.max(...measuredRuns.map((entry) => entry.summary.span.p99)),
    spanMax: Math.max(...measuredRuns.map((entry) => entry.summary.span.max)),
    scaleMedian: Math.min(...measuredRuns.map((entry) => entry.summary.scale.p50)),
    scaleMin: Math.min(...measuredRuns.map((entry) => entry.summary.scale.min)),
  };
  worstByShot[shot.name] = worst;
  const integrityProblems = measuredRuns.flatMap((entry, index) => entry.summary.integrityProblems.map((problem) => `run ${index + 1}: ${problem}`));
  for (const problem of integrityProblems) failures.push(`${shot.name} ${problem}`);
  if (worst.spanP99 > spanP99LimitMs) failures.push(`${shot.name} worst span p99 ${worst.spanP99.toFixed(2)} ms is over ${spanP99LimitMs} ms`);
  worstRows.push([shot.name, formatNumber(worst.spanP50), formatNumber(worst.spanP95), formatNumber(worst.spanP99), formatNumber(worst.spanMax), formatNumber(worst.scaleMedian, 3), formatNumber(worst.scaleMin, 3), worst.spanP99 <= spanP99LimitMs && !integrityProblems.length ? 'PASS' : 'FAIL']);
}
for (const run of runs) if (run.pageErrors.length) failures.push(`run ${run.runNumber}: ${run.pageErrors.length} page error(s)`);

console.log(`\nWorst value of each metric across ${runs.length} run(s) (span p99 must be <= ${spanP99LimitMs} ms):`);
console.log(formatTable(['shot', 'span p50', 'p95', 'p99', 'max', 'scale median', 'scale min', 'result'], worstRows, { rightAlignFrom: 1 }));

mkdirSync(path.dirname(evidencePath), { recursive: true });
writeFileSync(evidencePath, JSON.stringify({
  tool: 'bench.mjs',
  createdAt: new Date().toISOString(),
  settings: { runCount, measuredFrameCount, warmupFrameCount, paced, pinnedScale, spanP99LimitMs, shots: shots.map((shot) => shot.name), serve: server.mode },
  preflight: machine.checks,
  timestampProbe: machine.probe,
  runs: runs.map((run) => ({ ...run, shots: Object.fromEntries(Object.entries(run.shots).map(([name, entry]) => [name, entry.error ? entry : { summary: entry.summary, raw: entry.raw }])) })),
  worstByShot,
  failures,
}, null, 1));
console.log(`\nWrote ${evidencePath}`);

if (failures.length) {
  console.log(`\nbench FAILED:\n${failures.map((failure) => `  ${failure}`).join('\n')}`);
  process.exit(1);
}
console.log('\nbench PASSED');
