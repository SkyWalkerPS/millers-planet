import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const toolsDirectory = path.dirname(fileURLToPath(import.meta.url));
const pacerModulePath = path.resolve(process.argv[2] || process.env.PACER_MODULE || path.join(toolsDirectory, '..', 'src', 'core', 'pacing.js'));
const STREAM_SECONDS = 10;
const JITTER_MILLISECONDS = 0.3;
const WARM_UP_MILLISECONDS = 250;
const TARGET_INTERVAL_MILLISECONDS = 1000 / 60;
const EVERY_OTHER_TICK_TOLERANCE_MILLISECONDS = 0.6;
const AVERAGE_FPS_TOLERANCE = 1;
const STREAM_START_MILLISECONDS = 1234.5;

let createFramePacer;
try {
  ({ createFramePacer } = await import(pathToFileURL(pacerModulePath).href));
} catch (error) {
  console.error(`Could not load ${pacerModulePath}: ${error.message}`);
  process.exit(1);
}
if (typeof createFramePacer !== 'function') {
  console.error(`${pacerModulePath} does not export createFramePacer`);
  process.exit(1);
}

function seededRandom(seed) {
  let state = seed;
  return () => {
    state = (state * 16807) % 2147483647;
    return state / 2147483647;
  };
}

function makeTickTimes(refreshRateHz, { seed, stallAtMilliseconds = null, stallMilliseconds = 0 } = {}) {
  const random = seededRandom(seed);
  const tickInterval = 1000 / refreshRateHz;
  const tickTimes = [];
  for (let tickIndex = 0; tickIndex * tickInterval <= STREAM_SECONDS * 1000; tickIndex++) {
    const idealTime = tickIndex * tickInterval;
    if (stallAtMilliseconds !== null && idealTime >= stallAtMilliseconds && idealTime < stallAtMilliseconds + stallMilliseconds) continue;
    tickTimes.push(STREAM_START_MILLISECONDS + idealTime + (random() * 2 - 1) * JITTER_MILLISECONDS);
  }
  return tickTimes;
}

function runStream(tickTimes) {
  const pacer = createFramePacer({ targetIntervalMilliseconds: TARGET_INTERVAL_MILLISECONDS });
  return tickTimes.map((time) => Boolean(pacer.shouldRender(time)));
}

function describeStream(tickTimes, renderedFlags) {
  const renderedTicks = [];
  renderedFlags.forEach((rendered, tickIndex) => { if (rendered) renderedTicks.push(tickIndex); });
  const renderedSpanSeconds = (tickTimes[renderedTicks[renderedTicks.length - 1]] - tickTimes[renderedTicks[0]]) / 1000;
  const afterWarmUp = renderedTicks.filter((tickIndex) => tickTimes[tickIndex] - tickTimes[0] >= WARM_UP_MILLISECONDS);
  const tickGaps = [];
  const renderedIntervals = [];
  for (let position = 1; position < afterWarmUp.length; position++) {
    tickGaps.push(afterWarmUp[position] - afterWarmUp[position - 1]);
    renderedIntervals.push(tickTimes[afterWarmUp[position]] - tickTimes[afterWarmUp[position - 1]]);
  }
  return {
    renderedCount: renderedTicks.length,
    averageFps: (renderedTicks.length - 1) / renderedSpanSeconds,
    tickGaps,
    renderedIntervals,
    minimumInterval: Math.min(...renderedIntervals),
    maximumInterval: Math.max(...renderedIntervals),
  };
}

const results = [];
function check(label, passed, detail) {
  results.push({ label, passed });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${label}\n      ${detail}`);
}

console.log(`Testing createFramePacer from ${pacerModulePath}`);
console.log(`Synthetic requestAnimationFrame streams: ${STREAM_SECONDS} s each, +/-${JITTER_MILLISECONDS} ms jitter per tick; patterns are checked after the first ${WARM_UP_MILLISECONDS} ms.\n`);

for (const [index, refreshRateHz] of [60, 90, 120, 144].entries()) {
  const tickTimes = makeTickTimes(refreshRateHz, { seed: 1000 + index });
  const stream = describeStream(tickTimes, runStream(tickTimes));
  const summary = `${stream.renderedCount} of ${tickTimes.length} ticks rendered, ${stream.averageFps.toFixed(2)} fps average, rendered intervals ${stream.minimumInterval.toFixed(2)}-${stream.maximumInterval.toFixed(2)} ms`;
  if (refreshRateHz === 60) {
    const skipped = stream.tickGaps.filter((gap) => gap !== 1).length;
    check('60 Hz: renders on every tick', skipped === 0, `${summary}; ${skipped} skipped tick(s)`);
  } else if (refreshRateHz === 120) {
    const wrongGaps = stream.tickGaps.filter((gap) => gap !== 2).length;
    const intervalsOutside = stream.renderedIntervals.filter((interval) => Math.abs(interval - TARGET_INTERVAL_MILLISECONDS) > EVERY_OTHER_TICK_TOLERANCE_MILLISECONDS).length;
    check('120 Hz: renders exactly every other tick', wrongGaps === 0 && intervalsOutside === 0, `${summary}; ${wrongGaps} gap(s) other than 2 ticks, ${intervalsOutside} interval(s) outside 16.67 +/- ${EVERY_OTHER_TICK_TOLERANCE_MILLISECONDS} ms`);
  } else {
    check(`${refreshRateHz} Hz: averages 60 +/- ${AVERAGE_FPS_TOLERANCE} fps`, Math.abs(stream.averageFps - 60) <= AVERAGE_FPS_TOLERANCE, summary);
  }
}

{
  const pacer = createFramePacer({ targetIntervalMilliseconds: TARGET_INTERVAL_MILLISECONDS });
  const tickTimes = makeTickTimes(120, { seed: 7 }).slice(0, 120);
  for (const time of tickTimes) pacer.shouldRender(time);
  pacer.reset();
  const renderedAfterReset = Boolean(pacer.shouldRender(tickTimes[tickTimes.length - 1] + 5000));
  check('extra: reset() makes the next tick render', renderedAfterReset, `first tick after reset() ${renderedAfterReset ? 'rendered' : 'was skipped'}`);
}

{
  const stallAtMilliseconds = 4000;
  const tickTimes = makeTickTimes(120, { seed: 11, stallAtMilliseconds, stallMilliseconds: 500 });
  const renderedFlags = runStream(tickTimes);
  const firstTickAfterStall = tickTimes.findIndex((time) => time - STREAM_START_MILLISECONDS >= stallAtMilliseconds + 500);
  const windowEnd = tickTimes.findIndex((time) => time - STREAM_START_MILLISECONDS >= stallAtMilliseconds + 1500);
  let consecutiveRenders = 0;
  for (let tickIndex = firstTickAfterStall + 1; tickIndex < windowEnd; tickIndex++) if (renderedFlags[tickIndex] && renderedFlags[tickIndex - 1]) consecutiveRenders++;
  check('extra: after a 500 ms stall at 120 Hz there is no catch-up burst', consecutiveRenders === 0, `${consecutiveRenders} pair(s) of back-to-back rendered ticks in the second after the stall`);
}

const failed = results.filter((result) => !result.passed);
console.log(`\n${results.length - failed.length} of ${results.length} pacing check(s) passed`);
process.exit(failed.length ? 1 : 0);
