import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { fileUrl, launchChrome, sleep } from './cdp.mjs';
import { median, percentile, formatTable } from './stats.mjs';
import { openMillersPlanet, viewportFromEnvironment } from './target.mjs';

const runCommand = promisify(execFile);
const toolsDirectory = path.dirname(fileURLToPath(import.meta.url));
export const TIMESTAMP_PROBE_PAGE = path.join(toolsDirectory, 'probes', 'timestamp-probe.html');
export const QUANTIZATION_LIMIT_NANOSECONDS = 1000;
export const GPU_LOAD_WARNING_PERCENT = 10;
export const CAPPED_FRAME_RATE_INTERVAL_MS = 20;

const pass = (name, detail) => ({ name, status: 'PASS', detail });
const warn = (name, detail) => ({ name, status: 'WARN', detail });
const fail = (name, detail) => ({ name, status: 'FAIL', detail });

export function anyCheckFailed(checks) {
  return checks.some((check) => check.status === 'FAIL');
}

export function printChecks(checks, title = 'Machine and page checks') {
  console.log(`\n${title}`);
  console.log(formatTable(['check', 'result', 'details'], checks.map((check) => [check.name, check.status, check.detail]), { rightAlignFrom: 99 }));
}

export async function checkPowerSource({ strict = process.env.STRICT_POWER === '1' } = {}) {
  let output;
  try {
    ({ stdout: output } = await runCommand('pmset', ['-g', 'batt']));
  } catch (error) {
    return warn('power', `could not run pmset (${error.message})`);
  }
  const onAcPower = output.includes("'AC Power'");
  const batteryPercent = Number(output.match(/(\d+)%/)?.[1] ?? NaN);
  if (onAcPower) return pass('power', `on AC power${Number.isFinite(batteryPercent) ? ` (battery ${batteryPercent}%)` : ''}`);
  const lowBatteryNote = Number.isFinite(batteryPercent) && batteryPercent <= 20 ? ' At 20% or less Chrome caps animation at 30 fps, so paced timings will be wrong.' : '';
  const detail = `running on battery (${Number.isFinite(batteryPercent) ? `${batteryPercent}%` : 'level unknown'}); plug in for trustworthy timings.${lowBatteryNote}`;
  return strict ? fail('power', `${detail} STRICT_POWER=1 makes this a failure.`) : warn('power', detail);
}

export async function sampleGpuUtilisation({ sampleCount = 5, intervalMs = 200 } = {}) {
  const samples = [];
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
    const { stdout } = await runCommand('ioreg', ['-r', '-d', '1', '-c', 'IOAccelerator'], { maxBuffer: 16 * 1024 * 1024 });
    const values = [...stdout.matchAll(/"Device Utilization %"=(\d+)/g)].map((match) => Number(match[1]));
    if (values.length) samples.push(Math.max(...values));
    if (sampleIndex < sampleCount - 1) await sleep(intervalMs);
  }
  return samples;
}

export async function waitForQuietGpu({ quietChecksNeeded = 5, timeoutMs = Number(process.env.QUIET_GPU_TIMEOUT_MS || 900000), log = console.log } = {}) {
  const startedMs = Date.now();
  let quietChecks = 0;
  let announced = false;
  while (quietChecks < quietChecksNeeded) {
    if (Date.now() - startedMs > timeoutMs) return { quiet: false, waitedMs: Date.now() - startedMs };
    const otherBrowsers = await listHeadlessChromeProcesses();
    const samples = await sampleGpuUtilisation();
    const busyPercent = samples.length ? median(samples) : 0;
    if (!otherBrowsers.length && busyPercent <= GPU_LOAD_WARNING_PERCENT) {
      quietChecks++;
    } else {
      quietChecks = 0;
      if (!announced) {
        log(`  waiting for a quiet GPU (now ${busyPercent}% busy, ${otherBrowsers.length} other headless Chrome)...`);
        announced = true;
      }
      await sleep(2000);
    }
  }
  return { quiet: true, waitedMs: Date.now() - startedMs };
}

export async function checkGpuLoad({ strict = process.env.STRICT_GPU === '1' } = {}) {
  let samples;
  try {
    samples = await sampleGpuUtilisation();
  } catch (error) {
    return warn('GPU load', `could not run ioreg (${error.message})`);
  }
  if (!samples.length) return warn('GPU load', 'ioreg reported no "Device Utilization %" value');
  const medianLoad = median(samples);
  const detail = `GPU busy ${medianLoad}% before starting (samples ${samples.join(', ')}%)`;
  const check = medianLoad > GPU_LOAD_WARNING_PERCENT
    ? (strict ? fail : warn)('GPU load', `${detail}; other apps are using the GPU and will inflate GPU timings (limit ${GPU_LOAD_WARNING_PERCENT}%)`)
    : pass('GPU load', detail);
  check.samples = samples;
  check.medianPercent = medianLoad;
  return check;
}

export async function listHeadlessChromeProcesses() {
  let stdout = '';
  try {
    ({ stdout } = await runCommand('pgrep', ['-fl', '--', '--headless']));
  } catch (error) {
    if (error.code === 1) return [];
    throw error;
  }
  return stdout.split('\n').filter((line) => line.includes('Google Chrome') && line.includes('--headless') && !line.includes('--type=')).map((line) => {
    const processId = Number(line.split(' ')[0]);
    const userDataDirectory = line.match(/--user-data-dir=(\S+)/)?.[1] || '';
    return { processId, userDataDirectory };
  });
}

export async function checkStrayHeadlessChrome({ ownUserDataDirectories = [] } = {}) {
  let processes;
  try {
    processes = await listHeadlessChromeProcesses();
  } catch (error) {
    return warn('other headless Chrome', `could not run pgrep (${error.message})`);
  }
  const strays = processes.filter((entry) => !ownUserDataDirectories.includes(entry.userDataDirectory));
  if (!strays.length) return pass('other headless Chrome', 'none running');
  const profiles = strays.map((entry) => `pid ${entry.processId} ${path.basename(entry.userDataDirectory) || '(no profile)'}`).join('; ');
  return warn('other headless Chrome', `${strays.length} other headless Chrome browser(s) running (${profiles}). Another session may be using the GPU. This tool never kills them.`);
}

export function printBrowserPaneReminder() {
  console.log('Reminder: close the Claude desktop app\'s Browser pane tab before measuring. It renders pages on the same GPU and this tool cannot see it.');
}

export function gcdOfTimestampDifferences(stampStrings) {
  const stamps = stampStrings.map((value) => BigInt(value));
  if (stamps.length < 2) return null;
  const reference = stamps[0];
  let divisor = 0n;
  for (const stamp of stamps) {
    let difference = stamp - reference;
    if (difference < 0n) difference = -difference;
    let larger = divisor;
    let smaller = difference;
    while (smaller !== 0n) {
      const remainder = larger % smaller;
      larger = smaller;
      smaller = remainder;
    }
    divisor = larger;
  }
  return divisor === 0n ? null : Number(divisor);
}

export function analyseTimestampProbe(probeResult) {
  const stampPairs = probeResult.stampPairs || [];
  const spansNanoseconds = stampPairs.map(([begin, end]) => Number(BigInt(end) - BigInt(begin)));
  const validSpans = spansNanoseconds.filter((span) => span > 0 && span < 1e9);
  const rafIntervals = [];
  const rafTimes = probeResult.rafTimes || [];
  for (let index = 1; index < rafTimes.length; index++) rafIntervals.push(rafTimes[index] - rafTimes[index - 1]);
  return {
    vendor: probeResult.vendor,
    architecture: probeResult.architecture,
    hasTimestampQuery: probeResult.hasTimestampQuery,
    framesRequested: probeResult.framesRequested,
    framesTimed: stampPairs.length,
    framesWithoutReadback: probeResult.framesWithoutReadback,
    invalidSpans: spansNanoseconds.length - validSpans.length,
    gcdNanoseconds: gcdOfTimestampDifferences(stampPairs.flat()),
    distinctSpanCount: new Set(validSpans).size,
    passMicrosecondsMedian: validSpans.length ? median(validSpans) / 1000 : NaN,
    passMicrosecondsMax: validSpans.length ? Math.max(...validSpans) / 1000 : NaN,
    rafIntervalMedianMs: rafIntervals.length ? median(rafIntervals) : NaN,
    rafIntervalP99Ms: rafIntervals.length ? percentile(rafIntervals, 0.99) : NaN,
    uncapturedErrors: probeResult.uncapturedErrors || [],
    error: probeResult.error,
  };
}

export async function runTimestampProbe({ frames = 300, webGpuDeveloperFlags = true, timeoutMs = 60000 } = {}) {
  const browser = await launchChrome({ webGpuDeveloperFlags });
  try {
    const page = await browser.newPage();
    await page.setViewport(800, 600, 1);
    await page.goto(fileUrl(TIMESTAMP_PROBE_PAGE, { frames }));
    await page.waitFor('window.timestampProbe && window.timestampProbe.done', { timeoutMs, describe: 'the timestamp probe page to finish' });
    const probeResult = await page.evaluate('window.timestampProbe.result');
    return analyseTimestampProbe(probeResult);
  } finally {
    await browser.shutdown();
  }
}

export function checkTimestampProbe(analysis, { framesMustBePaced = true } = {}) {
  const checks = [];
  if (analysis.error) {
    checks.push(fail('WebGPU timestamp-query', `the probe page failed: ${analysis.error}`));
    return checks;
  }
  if (!analysis.hasTimestampQuery) {
    checks.push(fail('WebGPU timestamp-query', `the GPU adapter (${analysis.vendor || 'unknown vendor'}) does not offer timestamp-query, so GPU times cannot be measured. Refusing to report CPU-side guesses.`));
    return checks;
  }
  checks.push(pass('WebGPU timestamp-query', `adapter ${analysis.vendor || '?'} / ${analysis.architecture || '?'} has timestamp-query`));
  if (analysis.framesTimed < analysis.framesRequested * 0.9 || analysis.gcdNanoseconds === null) {
    checks.push(fail('timestamp precision', `only ${analysis.framesTimed} of ${analysis.framesRequested} probe frames returned usable timestamps`));
  } else if (analysis.gcdNanoseconds >= QUANTIZATION_LIMIT_NANOSECONDS) {
    checks.push(fail('timestamp precision', `timestamps are rounded to ${analysis.gcdNanoseconds} ns steps (limit ${QUANTIZATION_LIMIT_NANOSECONDS} ns), so short passes cannot be timed. Launch Chrome with the harness flags.`));
  } else {
    checks.push(pass('timestamp precision', `greatest common divisor of ${analysis.framesTimed * 2} raw stamps is ${analysis.gcdNanoseconds} ns (limit ${QUANTIZATION_LIMIT_NANOSECONDS} ns); ${analysis.distinctSpanCount} distinct pass times, median ${analysis.passMicrosecondsMedian.toFixed(1)} us`));
  }
  if (analysis.invalidSpans > 0) checks.push(warn('timestamp sanity', `${analysis.invalidSpans} probe passes had an end stamp before the begin stamp or over 1 s`));
  if (analysis.uncapturedErrors.length) checks.push(fail('probe GPU errors', analysis.uncapturedErrors.slice(0, 3).join(' | ')));
  if (Number.isFinite(analysis.rafIntervalMedianMs)) {
    const capped = analysis.rafIntervalMedianMs > CAPPED_FRAME_RATE_INTERVAL_MS;
    const detail = `median requestAnimationFrame interval ${analysis.rafIntervalMedianMs.toFixed(2)} ms (p99 ${analysis.rafIntervalP99Ms.toFixed(2)} ms)`;
    if (!capped) checks.push(pass('frame rate cap', `${detail}, so Chrome is not capping the frame rate`));
    else checks.push((framesMustBePaced ? fail : warn)('frame rate cap', `${detail}: Chrome is capping animation (battery saver at 20% or less?). Paced timings would be wrong.`));
  }
  return checks;
}

export async function readAppHealth(page) {
  return page.evaluate(`(() => {
    const stats = window.millersPlanet.stats();
    const gpu = stats.gpu || {};
    return {
      gpuSource: gpu.source ?? null,
      quantizedSuspect: gpu.quantizedSuspect ?? null,
      output: stats.output ? Array.from(stats.output) : null,
      internal: stats.internal ? Array.from(stats.internal) : null,
      adapter: stats.adapter || null,
      deviceLost: stats.deviceLost ?? null,
      gpuErrors: (stats.gpuErrors || []).map((entry) => typeof entry === 'string' ? entry : JSON.stringify(entry)),
      canvasSize: (() => { const canvas = document.querySelector('canvas'); return canvas ? [canvas.width, canvas.height] : null; })(),
    };
  })()`);
}

export async function checkAppPage(page, { viewport = viewportFromEnvironment() } = {}) {
  const health = await readAppHealth(page);
  const expectedOutput = [Math.round(viewport.width * viewport.deviceScaleFactor), Math.round(viewport.height * viewport.deviceScaleFactor)];
  const checks = [];
  checks.push(health.gpuSource === 'timestamp-query'
    ? pass('app GPU timing source', 'stats().gpu.source is timestamp-query')
    : fail('app GPU timing source', `stats().gpu.source is ${JSON.stringify(health.gpuSource)}, not "timestamp-query": the app's GPU numbers would be CPU-side guesses. Refusing to measure.`));
  if (health.quantizedSuspect === true) checks.push(fail('app timestamp precision', 'the app reports stats().gpu.quantizedSuspect = true (its timestamps look rounded)'));
  const outputMatches = Array.isArray(health.output) && health.output[0] === expectedOutput[0] && health.output[1] === expectedOutput[1];
  checks.push(outputMatches
    ? pass('app output size', `stats().output is ${health.output.join('x')}`)
    : fail('app output size', `stats().output is ${JSON.stringify(health.output)}, expected ${expectedOutput.join('x')} for a ${viewport.width}x${viewport.height} window at ${viewport.deviceScaleFactor}x`));
  const vendor = health.adapter?.vendor;
  checks.push(vendor === 'apple'
    ? pass('app GPU adapter', `vendor apple, architecture ${health.adapter.architecture || '?'}`)
    : fail('app GPU adapter', `stats().adapter.vendor is ${JSON.stringify(vendor)}, expected "apple" (the M3 Pro GPU)`));
  checks.push(health.deviceLost === false
    ? pass('app GPU device', 'not lost')
    : fail('app GPU device', `stats().deviceLost is ${JSON.stringify(health.deviceLost)}`));
  checks.push(health.gpuErrors.length === 0
    ? pass('app GPU errors', 'stats().gpuErrors is empty')
    : fail('app GPU errors', health.gpuErrors.slice(0, 3).join(' | ')));
  return { checks, health };
}

export async function runMachineChecks({ includeTimestampProbe = true, framesMustBePaced = true } = {}) {
  const checks = [await checkPowerSource(), await checkGpuLoad(), await checkStrayHeadlessChrome()];
  let probe = null;
  if (includeTimestampProbe) {
    probe = await runTimestampProbe();
    checks.push(...checkTimestampProbe(probe, { framesMustBePaced }));
  }
  return { checks, probe };
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  printBrowserPaneReminder();
  const { checks } = await runMachineChecks();
  if (process.env.SKIP_APP === '1') {
    checks.push(warn('app checks', 'skipped because SKIP_APP=1'));
  } else {
    let target = null;
    try {
      target = await openMillersPlanet({ query: { scale: 0.5 } });
      const { checks: appChecks } = await checkAppPage(target.page, { viewport: target.viewport });
      checks.push(...appChecks);
    } catch (error) {
      checks.push(fail('app start-up', error.message.split('\n').slice(0, 6).join(' / ')));
    } finally {
      if (target) await target.close();
    }
  }
  printChecks(checks);
  const failed = anyCheckFailed(checks);
  console.log(failed ? '\nPreflight FAILED: fix the items marked FAIL before measuring.' : '\nPreflight passed (warnings, if any, are listed above).');
  process.exit(failed ? 2 : 0);
}
