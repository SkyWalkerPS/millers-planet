import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep } from './cdp.mjs';
import { anyCheckFailed, checkAppPage, checkGpuLoad, checkStrayHeadlessChrome, printBrowserPaneReminder, printChecks, runMachineChecks } from './preflight.mjs';
import { evidenceDirectory, openMillersPlanet, startMillersPlanetServer } from './target.mjs';
import { normaliseFrameLog, pageExpression } from './page-results.mjs';
import { formatNumber, formatTable, median, summarise } from './stats.mjs';

export const FLIGHT_PASS_RULE = {
  spanP99MaxMs: 14.0,
  spanMaxMs: 16.6,
  intervalMaxMs: 16.8,
  intervalEpsilonMs: 0.05,
  scaleMedianMin: 0.7,
  scaleMinMin: 0.5,
};
export const CONTROLLER_TARGET_MS = 11.0;
const DRIVER_TICK_MS = 100;
const LOG_READ_EVERY_MS = 5000;
const LOG_OVERLAP_FRAMES = 64;
const STEP_RESPONSE_WINDOW_MS = 2000;
const RECOVERY_RUN_FRAMES = 12;

const orbitPose = (yawDegrees, pitchDegrees, distance, targetHeight = 1.6) => ({ yawDegrees, pitchDegrees, distance, targetHeight });

export const FLIGHT_TIMELINES = {
  empty: {
    phase: 2,
    summary: 'phase 2: debug orbit sweeps over the test scene, abrupt camera jumps standing in for preset changes, and a step from sky only to full ground',
    segments: [
      { untilSeconds: 5, label: 'sweep right over the test scene', from: orbitPose(0, 4, 8), to: orbitPose(120, 10, 6) },
      { untilSeconds: 10, label: 'abrupt jump, then sweep with rising pitch', from: orbitPose(210, -5, 3.2), to: orbitPose(330, 20, 3.2) },
      { untilSeconds: 14, label: 'abrupt jump to a close view, then tilt up', from: orbitPose(20, 2, 1.8, 1.5), to: orbitPose(40, 30, 1.8, 1.5) },
      { untilSeconds: 18, label: 'sky only (looking up)', from: orbitPose(40, 70, 1.5), to: orbitPose(40, 70, 1.5), stepRole: 'before' },
      { untilSeconds: 22, label: 'step to full ground (looking down)', from: orbitPose(40, -70, 4), to: orbitPose(40, -70, 4), stepRole: 'after' },
      { untilSeconds: 26, label: 'climb out of the ground view and sweep', from: orbitPose(40, -70, 4), to: orbitPose(220, 5, 10) },
      { untilSeconds: 30, label: 'abrupt jump to a third-person view, then final sweep', from: orbitPose(300, 3, 3.2, 1.45), to: orbitPose(420, 8, 3.2, 1.45) },
    ],
  },
  sea: {
    phase: 4,
    summary: 'phase 4: eye-height sweeps over the FFT sea toward and away from Gargantua, a close look down at the water, then a step from sky only to the heaviest view with the placeholder wave and underwater pass switched on',
    setup: [['setCameraShot', 'sea-wide']],
    segments: [
      { untilSeconds: 5, label: 'sweep toward Gargantua over the sea', from: orbitPose(-40, 2, 3.2, 1.45), to: orbitPose(40, 4, 3.2, 1.45), systems: { waveReservation: false } },
      { untilSeconds: 10, label: 'abrupt jump, sweep facing away', from: orbitPose(140, -5, 3.2, 1.45), to: orbitPose(220, 0, 3.2, 1.45) },
      { untilSeconds: 14, label: 'close view down at the water', from: orbitPose(20, -50, 1.8, 1.5), to: orbitPose(60, -35, 1.8, 1.5) },
      { untilSeconds: 18, label: 'sky only (looking up)', from: orbitPose(40, 70, 1.5), to: orbitPose(40, 70, 1.5), stepRole: 'before' },
      { untilSeconds: 22, label: 'step to the wave wall with the underwater pass', from: orbitPose(0, 5, 3.2, 1.45), to: orbitPose(0, 5, 3.2, 1.45), stepRole: 'after', systems: { waveReservation: true } },
      { untilSeconds: 26, label: 'sweep under the wave wall', from: orbitPose(-30, 15, 3.2, 1.45), to: orbitPose(30, 20, 3.2, 1.45) },
      { untilSeconds: 30, label: 'wave off, third-person sweep', from: orbitPose(300, 3, 3.2, 1.45), to: orbitPose(420, 8, 3.2, 1.45), systems: { waveReservation: false } },
    ],
  },
  wave: {
    phase: 7,
    summary: 'phase 7: the first wave from T-22 to T+8 in player mode: walking toward the wall, looking up and around at the crest, then the locked brace with the scripted camera, the underwater pass and the drain',
    setup: [['debug.enterPlayerMode'], ['debug.setAstronautPosition', { x: 0, z: 0, yawDegrees: 0 }], ['skipTo', { waveIndex: 1, phase: 'impact', secondsIntoPhase: -25 }]],
    segments: [
      { untilSeconds: 6, label: 'walk toward the wall (W), about T-22 to T-16', input: { keys: ['KeyW'] } },
      { untilSeconds: 12, label: 'stop, look up and around at the crest, about T-16 to T-10', input: { keys: [], mouseCountsPerSecond: [260, -90] } },
      { untilSeconds: 30, label: 'brace, underwater and drain (input locked from T-8)', input: { keys: [] } },
    ],
  },
  walk: {
    phase: 5,
    summary: 'phase 5: the astronaut in player mode driven by injected keys and mouse: walking, orbiting the camera while walking, Shift, stopping, the close and first-person presets, a turn back toward the camera, and looking up at Gargantua',
    setup: [['debug.enterPlayerMode'], ['debug.setAstronautPosition', { x: 0, z: 0, yawDegrees: 0 }]],
    segments: [
      { untilSeconds: 6, label: 'walk forward (W)', input: { keys: ['KeyW'] } },
      { untilSeconds: 10, label: 'walk while orbiting the camera right', input: { keys: ['KeyW'], mouseCountsPerSecond: [300, 0] } },
      { untilSeconds: 13, label: 'Shift walk', input: { keys: ['ShiftLeft', 'KeyW'] } },
      { untilSeconds: 15, label: 'stop', input: { keys: [] } },
      { untilSeconds: 19, label: 'C: close preset, walk', input: { keys: ['KeyW'], pressAtStart: ['KeyC'] } },
      { untilSeconds: 23, label: 'C: first person, walk and look around', input: { keys: ['KeyW'], mouseCountsPerSecond: [450, -60], pressAtStart: ['KeyC'] } },
      { untilSeconds: 26, label: 'C: back to third person, turn and walk toward the camera (S)', input: { keys: ['KeyS'], pressAtStart: ['KeyC'] } },
      { untilSeconds: 30, label: 'stop and look up at the sky', input: { keys: [], mouseCountsPerSecond: [0, -220] } },
    ],
  },
};

const smoothstep = (fraction) => fraction * fraction * (3 - 2 * fraction);

export function segmentAt(timeline, flightSeconds) {
  let segmentStart = 0;
  for (let index = 0; index < timeline.segments.length; index++) {
    const segment = timeline.segments[index];
    if (flightSeconds < segment.untilSeconds || index === timeline.segments.length - 1) return { segment, index, segmentStart };
    segmentStart = segment.untilSeconds;
  }
  return null;
}

export function poseWithinSegment(segment, segmentStart, flightSeconds) {
  const fraction = smoothstep(Math.min(1, Math.max(0, (flightSeconds - segmentStart) / (segment.untilSeconds - segmentStart))));
  const pose = {};
  for (const key of Object.keys(segment.from)) pose[key] = segment.from[key] + (segment.to[key] - segment.from[key]) * fraction;
  return pose;
}

const LATEST_FRAME_INDEX_EXPRESSION = `(() => {
  const log = window.millersPlanet.frameLog(Number.MAX_SAFE_INTEGER);
  if (log && typeof log.latestFrameIndex === 'number') return log.latestFrameIndex;
  const full = window.millersPlanet.frameLog(-1);
  const indices = Array.isArray(full) ? full.map((record) => record.frameIndex) : (full.frameIndex || []);
  return indices.length ? indices[indices.length - 1] : -1;
})()`;

async function moveCamera(page, pose, transitionSeconds) {
  await page.evaluate(`window.millersPlanet.debug.setOrbitCamera(${JSON.stringify({ ...pose, transitionSeconds })})`);
}

async function startInputSegment(page, input) {
  return page.evaluate(`(() => {
    window.millersPlanet.injectInput({ keys: ${JSON.stringify(input.keys ?? [])}, press: ${JSON.stringify(input.pressAtStart ?? [])}, durationMs: ${DRIVER_TICK_MS + 60} });
    return { afterFrameIndex: ${LATEST_FRAME_INDEX_EXPRESSION}, timeMs: performance.now() };
  })()`);
}

async function holdInput(page, input) {
  const tickSeconds = DRIVER_TICK_MS / 1000;
  const [countsX, countsY] = input.mouseCountsPerSecond ?? [0, 0];
  await page.evaluate(`window.millersPlanet.injectInput({ keys: ${JSON.stringify(input.keys ?? [])}, mouseDelta: [${countsX * tickSeconds}, ${countsY * tickSeconds}], durationMs: ${DRIVER_TICK_MS + 60} })`);
}

async function jumpCamera(page, pose) {
  return page.evaluate(`(() => {
    window.millersPlanet.debug.setOrbitCamera(${JSON.stringify({ ...pose, transitionSeconds: 0 })});
    return { afterFrameIndex: ${LATEST_FRAME_INDEX_EXPRESSION}, timeMs: performance.now() };
  })()`);
}

async function readFrameLogInto(page, sinceFrameIndex, recordsByFrameIndex) {
  const log = normaliseFrameLog(await page.evaluate(pageExpression(`window.millersPlanet.frameLog(${sinceFrameIndex})`)));
  for (const record of log.records) recordsByFrameIndex.set(record.frameIndex, record);
  return log;
}

function framesInSegment(records, markers, markerIndex) {
  const marker = markers[markerIndex];
  const nextMarker = markers[markerIndex + 1];
  return records.filter((record) => record.frameIndex > marker.afterFrameIndex && (!nextMarker || record.frameIndex <= nextMarker.afterFrameIndex));
}

function analyseStepResponse(records, markers, timeline) {
  const beforeSegment = timeline.segments.find((segment) => segment.stepRole === 'before');
  const afterSegment = timeline.segments.find((segment) => segment.stepRole === 'after');
  if (!beforeSegment || !afterSegment) return null;
  const beforeIndex = markers.findIndex((marker) => marker.label === beforeSegment.label);
  const stepIndex = markers.findIndex((marker) => marker.label === afterSegment.label);
  if (beforeIndex === -1 || stepIndex === -1) return { error: 'the flight ended before the step from sky to ground' };
  const beforeFrames = framesInSegment(records, markers, beforeIndex);
  const afterFrames = framesInSegment(records, markers, stepIndex);
  if (!afterFrames.length || !beforeFrames.length) return { error: 'no timed frames around the step' };
  const windowEndMs = afterFrames[0].rafTimeMs + STEP_RESPONSE_WINDOW_MS;
  const windowFrames = afterFrames.filter((record) => record.rafTimeMs < windowEndMs);
  let recoveryFrame = null;
  let calmRun = 0;
  for (let index = 0; index < afterFrames.length; index++) {
    calmRun = afterFrames[index].gpuSpanMs <= CONTROLLER_TARGET_MS ? calmRun + 1 : 0;
    if (calmRun === RECOVERY_RUN_FRAMES) {
      recoveryFrame = index - RECOVERY_RUN_FRAMES + 1;
      break;
    }
  }
  const response = {
    skyOnlySpanMedianMs: median(beforeFrames.map((record) => record.gpuSpanMs)),
    fullGroundSpanMedianMs: median(afterFrames.map((record) => record.gpuSpanMs)),
    scaleBeforeStep: median(beforeFrames.slice(-30).map((record) => record.scale)),
    scaleMinAfterStep: Math.min(...windowFrames.map((record) => record.scale)),
    maxSpanInWindowMs: Math.max(...windowFrames.map((record) => record.gpuSpanMs)),
    framesOverSpanMaxInWindow: windowFrames.filter((record) => record.gpuSpanMs > FLIGHT_PASS_RULE.spanMaxMs).length,
    framesOverTargetBeforeRecovery: afterFrames.slice(0, recoveryFrame ?? afterFrames.length).filter((record) => record.gpuSpanMs > CONTROLLER_TARGET_MS).length,
    framesToRecover: recoveryFrame,
    targetMs: CONTROLLER_TARGET_MS,
    windowMs: STEP_RESPONSE_WINDOW_MS,
  };
  response.directionLooksRight = response.skyOnlySpanMedianMs < response.fullGroundSpanMedianMs;
  return response;
}

export function analyseFlight({ records, firstFrameIndex, lastFrameIndex, markers, timeline }) {
  const expectedFrameCount = Math.max(0, lastFrameIndex - firstFrameIndex + 1);
  const presentRecords = records.filter((record) => record.frameIndex >= firstFrameIndex && record.frameIndex <= lastFrameIndex).sort((a, b) => a.frameIndex - b.frameIndex);
  const missingFrameCount = expectedFrameCount - presentRecords.length;
  const startPageMs = markers[0]?.timeMs ?? presentRecords[0]?.rafTimeMs ?? 0;
  const segmentLabelFor = (frameIndex) => {
    let label = '';
    for (const marker of markers) if (marker.afterFrameIndex < frameIndex) label = marker.label;
    return label;
  };
  const spans = presentRecords.map((record) => record.gpuSpanMs).filter(Number.isFinite);
  const scales = presentRecords.map((record) => record.scale).filter(Number.isFinite);
  const busy = presentRecords.map((record) => record.gpuBusyMs).filter(Number.isFinite);
  const clockSlowdowns = presentRecords.map((record) => record.clockSlowdown).filter((value) => Number.isFinite(value) && value > 0);
  const normalizedSpans = presentRecords.filter((record) => Number.isFinite(record.gpuSpanMs) && record.clockSlowdown > 0).map((record) => record.gpuSpanMs / Math.max(record.clockSlowdown, 1));
  const intervals = [];
  for (let index = 1; index < presentRecords.length; index++) {
    const previous = presentRecords[index - 1];
    const current = presentRecords[index];
    if (current.frameIndex === previous.frameIndex + 1) intervals.push({ frameIndex: current.frameIndex, rafTimeMs: current.rafTimeMs, intervalMs: Math.round((current.rafTimeMs - previous.rafTimeMs) * 1000) / 1000 });
  }
  const flightSecondsOf = (rafTimeMs) => Math.round((rafTimeMs - startPageMs) / 10) / 100;
  const generations = presentRecords.map((record) => record.generation).filter((value) => value !== undefined && value !== null);
  let reallocations = 0;
  for (let index = 1; index < generations.length; index++) if (generations[index] !== generations[index - 1]) reallocations++;
  const spanSummary = summarise(spans);
  const intervalSummary = summarise(intervals.map((entry) => entry.intervalMs));
  const scaleSummary = summarise(scales);
  const rule = FLIGHT_PASS_RULE;
  const verdicts = [
    { metric: 'GPU span p99 (ms)', value: spanSummary.p99, limit: `<= ${rule.spanP99MaxMs}`, pass: spanSummary.p99 <= rule.spanP99MaxMs, worse: 'higher' },
    { metric: 'GPU span max (ms)', value: spanSummary.max, limit: `<= ${rule.spanMaxMs}`, pass: spanSummary.max <= rule.spanMaxMs, worse: 'higher' },
    { metric: 'frame interval max (ms)', value: intervalSummary.max, limit: `<= ${rule.intervalMaxMs} (+${rule.intervalEpsilonMs} for 0.1 ms rAF steps)`, pass: intervalSummary.max <= rule.intervalMaxMs + rule.intervalEpsilonMs, worse: 'higher' },
    { metric: 'render scale median', value: scaleSummary.p50, limit: `>= ${rule.scaleMedianMin}`, pass: scaleSummary.p50 >= rule.scaleMedianMin, worse: 'lower' },
    { metric: 'render scale min', value: scaleSummary.min, limit: `>= ${rule.scaleMinMin}`, pass: scaleSummary.min >= rule.scaleMinMin, worse: 'lower' },
    { metric: 'frames without GPU timing', value: missingFrameCount, limit: '= 0', pass: missingFrameCount === 0 && expectedFrameCount > 0, worse: 'higher' },
  ];
  return {
    expectedFrameCount,
    timedFrameCount: presentRecords.length,
    missingFrameCount,
    span: spanSummary,
    busy: summarise(busy),
    clockSlowdown: summarise(clockSlowdowns),
    normalizedSpan: summarise(normalizedSpans),
    framesOverSpanMax: spans.filter((value) => value > rule.spanMaxMs).length,
    interval: intervalSummary,
    intervalsMeasured: intervals.length,
    intervalsOverLimit: intervals.filter((entry) => entry.intervalMs > rule.intervalMaxMs + rule.intervalEpsilonMs).length,
    scale: scaleSummary,
    reallocations,
    slowestFrames: [...presentRecords].sort((a, b) => b.gpuSpanMs - a.gpuSpanMs).slice(0, 5).map((record) => ({ frameIndex: record.frameIndex, flightSeconds: flightSecondsOf(record.rafTimeMs), segment: segmentLabelFor(record.frameIndex), gpuSpanMs: record.gpuSpanMs, gpuBusyMs: record.gpuBusyMs, scale: record.scale, cameraMode: record.cameraMode })),
    longestIntervals: [...intervals].sort((a, b) => b.intervalMs - a.intervalMs).slice(0, 5).map((entry) => ({ frameIndex: entry.frameIndex, flightSeconds: flightSecondsOf(entry.rafTimeMs), segment: segmentLabelFor(entry.frameIndex), intervalMs: entry.intervalMs })),
    segments: markers.map((marker, markerIndex) => {
      const segmentRecords = framesInSegment(presentRecords, markers, markerIndex);
      return { label: marker.label, frames: segmentRecords.length, spanMedianMs: median(segmentRecords.map((record) => record.gpuSpanMs)), spanMaxMs: segmentRecords.length ? Math.max(...segmentRecords.map((record) => record.gpuSpanMs)) : NaN, scaleMedian: median(segmentRecords.map((record) => record.scale)) };
    }),
    stepResponse: analyseStepResponse(presentRecords, markers, timeline),
    verdicts,
    pass: verdicts.every((verdict) => verdict.pass),
  };
}

function digitsForMetric(metric) {
  if (metric.startsWith('render')) return 3;
  if (metric.startsWith('frames')) return 0;
  return 2;
}

function formatVerdictTable(analysis) {
  return formatTable(['metric', 'value', 'limit', 'result'], analysis.verdicts.map((verdict) => [verdict.metric, formatNumber(verdict.value, digitsForMetric(verdict.metric)), verdict.limit, verdict.pass ? 'PASS' : 'FAIL']), { rightAlignFrom: 1 });
}

const hudHidden = process.env.HUD === '0';
const maximumScaleCap = process.env.MAX_SCALE ? Number(process.env.MAX_SCALE) : null;

async function flyOnce({ server, timeline, flightSeconds, settleSeconds, runNumber, verbose }) {
  const gpuLoad = await checkGpuLoad();
  const otherChrome = await checkStrayHeadlessChrome();
  const target = await openMillersPlanet({ server, query: hudHidden ? { hud: '0' } : {} });
  try {
    const { page } = target;
    const { checks: appChecks } = await checkAppPage(page, { viewport: target.viewport });
    if (anyCheckFailed(appChecks)) return { refused: true, appChecks };
    const hasOrbitCamera = await page.evaluate("typeof window.millersPlanet?.debug?.setOrbitCamera === 'function'");
    if (!hasOrbitCamera) throw new Error('millersPlanet.debug.setOrbitCamera is missing, so the flight cannot drive the camera');
    for (const [method, ...methodArguments] of timeline.setup ?? []) {
      await page.evaluate(`window.millersPlanet.${method}(...${JSON.stringify(methodArguments)})`);
    }
    if (maximumScaleCap !== null) {
      await page.evaluate(`window.millersPlanet.debug.setResolutionLimits(${JSON.stringify({ maximumScale: maximumScaleCap, minimumScale: Math.min(0.5, maximumScaleCap * 0.7) })})`);
    }
    await page.evaluate('window.millersPlanet.freezeTime(null)');
    if (!timeline.segments[0].input) await jumpCamera(page, timeline.segments[0].from);
    await sleep(settleSeconds * 1000);
    const latestBeforeFlight = await page.evaluate(LATEST_FRAME_INDEX_EXPRESSION);
    const recordsByFrameIndex = new Map();
    const markers = [];
    let activeSegmentIndex = -1;
    let highestSeenFrameIndex = latestBeforeFlight;
    const startNodeMs = Date.now();
    let nextLogReadMs = startNodeMs + LOG_READ_EVERY_MS;
    for (let tick = 0; ; tick++) {
      const flightTimeSeconds = (Date.now() - startNodeMs) / 1000;
      if (flightTimeSeconds >= flightSeconds) break;
      const { segment, index, segmentStart } = segmentAt(timeline, flightTimeSeconds);
      if (index !== activeSegmentIndex) {
        activeSegmentIndex = index;
        for (const [systemName, enabled] of Object.entries(segment.systems ?? {})) {
          await page.evaluate(`window.millersPlanet.setSystemEnabled(${JSON.stringify(systemName)}, ${enabled ? 'true' : 'false'})`);
        }
        const jump = segment.input ? await startInputSegment(page, segment.input) : await jumpCamera(page, poseWithinSegment(segment, segmentStart, flightTimeSeconds));
        markers.push({ label: segment.label, afterFrameIndex: jump.afterFrameIndex, timeMs: jump.timeMs, flightSeconds: Math.round(flightTimeSeconds * 100) / 100 });
        if (verbose) console.log(`  ${flightTimeSeconds.toFixed(1)} s: ${segment.label}`);
      }
      const targetSeconds = Math.min(flightTimeSeconds + DRIVER_TICK_MS / 1000, segment.untilSeconds, flightSeconds);
      if (segment.input) {
        await holdInput(page, segment.input);
      } else {
        await moveCamera(page, poseWithinSegment(segment, segmentStart, targetSeconds), Math.max(0, targetSeconds - flightTimeSeconds));
      }
      if (Date.now() >= nextLogReadMs) {
        nextLogReadMs += LOG_READ_EVERY_MS;
        const log = await readFrameLogInto(page, Math.max(latestBeforeFlight, highestSeenFrameIndex - LOG_OVERLAP_FRAMES), recordsByFrameIndex);
        for (const record of log.records) highestSeenFrameIndex = Math.max(highestSeenFrameIndex, record.frameIndex);
        if (verbose) console.log(`  ${flightTimeSeconds.toFixed(1)} s: ${recordsByFrameIndex.size} timed frames so far`);
      }
      await sleep(Math.max(0, startNodeMs + (tick + 1) * DRIVER_TICK_MS - Date.now()));
    }
    const latestAtStop = await page.evaluate(LATEST_FRAME_INDEX_EXPRESSION);
    await sleep(400);
    const finalLog = await readFrameLogInto(page, Math.max(latestBeforeFlight, highestSeenFrameIndex - LOG_OVERLAP_FRAMES), recordsByFrameIndex);
    const records = [...recordsByFrameIndex.values()].filter((record) => record.frameIndex > latestBeforeFlight && record.frameIndex <= latestAtStop).sort((a, b) => a.frameIndex - b.frameIndex);
    const analysis = analyseFlight({ records, firstFrameIndex: latestBeforeFlight + 1, lastFrameIndex: latestAtStop, markers, timeline });
    const statsAfter = await page.evaluate(pageExpression('(() => { const stats = window.millersPlanet.stats(); return { gpuErrors: stats.gpuErrors || [], deviceLost: stats.deviceLost, gpu: stats.gpu || {} }; })()'));
    return {
      runNumber,
      gpuLoadBefore: { status: gpuLoad.status, samples: gpuLoad.samples, medianPercent: gpuLoad.medianPercent },
      otherHeadlessChromeBefore: { status: otherChrome.status, detail: otherChrome.detail },
      markers,
      analysis,
      gpuErrors: statsAfter.gpuErrors,
      deviceLost: statsAfter.deviceLost,
      framesWithoutFreeReadback: statsAfter.gpu.framesWithoutFreeReadback ?? null,
      pageErrors: page.pageErrors().map((event) => `[${event.kind}] ${event.text}`),
      frames: {
        labelNames: finalLog.labelNames,
        frameIndex: records.map((record) => record.frameIndex),
        rafTimeMs: records.map((record) => record.rafTimeMs),
        gpuSpanMs: records.map((record) => record.gpuSpanMs),
        gpuBusyMs: records.map((record) => record.gpuBusyMs),
        scale: records.map((record) => record.scale),
        generation: records.map((record) => record.generation),
        wavePhaseCode: records.map((record) => record.wavePhaseCode),
        cameraMode: records.map((record) => record.cameraMode),
        passMs: records.map((record) => record.passMs),
      },
    };
  } finally {
    await target.close();
  }
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  const flightName = process.env.FLIGHT || 'empty';
  const timeline = FLIGHT_TIMELINES[flightName];
  if (!timeline) {
    console.error(`Unknown FLIGHT "${flightName}". Known flights: ${Object.keys(FLIGHT_TIMELINES).join(', ')}`);
    process.exit(1);
  }
  if (timeline.stub) {
    console.error(timeline.stub);
    process.exit(1);
  }
  if (process.env.SCALE) {
    console.error('flight.mjs needs the dynamic-resolution controller running, so it refuses a pinned SCALE. Unset SCALE and run again.');
    process.exit(1);
  }
  const runCount = Number(process.env.RUNS || 3);
  const flightSeconds = Number(process.env.SECONDS || timeline.segments[timeline.segments.length - 1].untilSeconds);
  const settleSeconds = Number(process.env.SETTLE_SECONDS || 3);
  const phase = Number(process.env.PHASE || timeline.phase);
  const verbose = process.env.VERBOSE === '1';

  if (maximumScaleCap !== null) console.log(`Diagnostic run: the resolution controller is capped at scale ${maximumScaleCap} (MAX_SCALE), so the scale rules cannot pass by design.`);
  printBrowserPaneReminder();
  const machine = await runMachineChecks({ framesMustBePaced: true });
  printChecks(machine.checks, 'Preflight');
  if (anyCheckFailed(machine.checks)) {
    console.error('\nFLIGHT REFUSED TO RUN: a preflight check failed (see FAIL above).');
    process.exit(2);
  }
  const server = await startMillersPlanetServer();
  for (const warning of server.warnings) console.warn(`WARNING: ${warning}`);
  const runs = [];
  let refused = null;
  try {
    console.log(`\nFlight "${flightName}" (${timeline.summary})${hudHidden ? ', HUD hidden with ?hud=0' : ''}`);
    console.log(`${runCount} fresh run(s) of ${flightSeconds} s from ${server.description}, controller live, ${settleSeconds} s settle before each run`);
    for (let runNumber = 1; runNumber <= runCount; runNumber++) {
      const run = await flyOnce({ server, timeline, flightSeconds, settleSeconds, runNumber, verbose });
      if (run.refused) {
        refused = run;
        break;
      }
      runs.push(run);
      const analysis = run.analysis;
      console.log(`\nRun ${runNumber} of ${runCount}: ${analysis.timedFrameCount} timed frames of ${analysis.expectedFrameCount} rendered (${(analysis.expectedFrameCount / flightSeconds).toFixed(1)} fps), GPU busy before the run ${run.gpuLoadBefore.medianPercent ?? '?'}%`);
      if (run.otherHeadlessChromeBefore.status !== 'PASS') console.log(`  WARNING before this run: ${run.otherHeadlessChromeBefore.detail}`);
      console.log(formatVerdictTable(analysis));
      console.log(`  span p50 ${formatNumber(analysis.span.p50)} / p95 ${formatNumber(analysis.span.p95)} ms, busy p99 ${formatNumber(analysis.busy.p99)} ms, ${analysis.framesOverSpanMax} frame(s) over ${FLIGHT_PASS_RULE.spanMaxMs} ms`);
      if (analysis.clockSlowdown.count) console.log(`  GPU clock slowdown (fixed-cost passes vs the fastest seen) p50 ${formatNumber(analysis.clockSlowdown.p50)} / max ${formatNumber(analysis.clockSlowdown.max)}; span at full clock p50 ${formatNumber(analysis.normalizedSpan.p50)} / p99 ${formatNumber(analysis.normalizedSpan.p99)} / max ${formatNumber(analysis.normalizedSpan.max)} ms (diagnostic, not the pass rule)`);
      console.log(`  interval p50 ${formatNumber(analysis.interval.p50)} / p99 ${formatNumber(analysis.interval.p99)} ms over ${analysis.intervalsMeasured} measured intervals, ${analysis.intervalsOverLimit} over the limit; scale max ${formatNumber(analysis.scale.max, 3)}; render-target reallocations ${analysis.reallocations}`);
      console.log(`  slowest frames (span, with GPU busy time in brackets; a big difference means idle gaps inside the frame): ${analysis.slowestFrames.map((frame) => `${formatNumber(frame.gpuSpanMs)} ms (busy ${formatNumber(frame.gpuBusyMs)}) at ${frame.flightSeconds} s (${frame.segment}, scale ${formatNumber(frame.scale, 3)})`).join('; ')}`);
      console.log(`  longest intervals: ${analysis.longestIntervals.map((entry) => `${formatNumber(entry.intervalMs)} ms at ${entry.flightSeconds} s (${entry.segment})`).join('; ')}`);
      console.log(`  per segment (frames, median / max span ms, median scale):\n${analysis.segments.map((segment) => `    ${segment.label}: ${segment.frames}, ${formatNumber(segment.spanMedianMs)} / ${formatNumber(segment.spanMaxMs)}, ${formatNumber(segment.scaleMedian, 3)}`).join('\n')}`);
      const step = analysis.stepResponse;
      if (step && !step.error) {
        console.log(`  step from sky only to full ground: median span ${formatNumber(step.skyOnlySpanMedianMs)} -> ${formatNumber(step.fullGroundSpanMedianMs)} ms, scale ${formatNumber(step.scaleBeforeStep, 3)} -> min ${formatNumber(step.scaleMinAfterStep, 3)}; in the first ${step.windowMs / 1000} s max span ${formatNumber(step.maxSpanInWindowMs)} ms, ${step.framesOverSpanMaxInWindow} frame(s) over ${FLIGHT_PASS_RULE.spanMaxMs} ms; ${step.framesOverTargetBeforeRecovery} frame(s) over the ${step.targetMs} ms target before ${step.framesToRecover === null ? 'it never settled' : `it settled after ${step.framesToRecover} frame(s)`}`);
        if (!step.directionLooksRight) console.log('  WARNING: the "sky only" view was not cheaper than the "full ground" view. Check that a positive pitchDegrees in debug.setOrbitCamera looks up.');
      } else if (step?.error) {
        console.log(`  step response: ${step.error}`);
      }
      if (run.gpuErrors.length) console.log(`  GPU errors: ${run.gpuErrors.slice(0, 3).join(' | ')}`);
      if (run.pageErrors.length) console.log(`  page errors:\n${run.pageErrors.map((line) => `    ${line}`).join('\n')}`);
      const evidencePath = path.join(evidenceDirectory(), `${phase}-flight${hudHidden ? '-hud-off' : ''}-run${runNumber}.json`);
      mkdirSync(path.dirname(evidencePath), { recursive: true });
      writeFileSync(evidencePath, JSON.stringify({ tool: 'flight.mjs', flight: flightName, createdAt: new Date().toISOString(), passRule: FLIGHT_PASS_RULE, maximumScaleCap, preflight: machine.checks, ...run }, null, 1));
      console.log(`  wrote ${evidencePath}`);
    }
  } finally {
    await server.close();
  }
  if (refused) {
    printChecks(refused.appChecks, 'App checks');
    console.error('\nFLIGHT REFUSED TO RUN: the app failed a preflight check (see FAIL above).');
    process.exit(2);
  }
  const worstRows = runs[0].analysis.verdicts.map((firstVerdict, verdictIndex) => {
    const values = runs.map((run) => run.analysis.verdicts[verdictIndex].value);
    const worst = firstVerdict.worse === 'higher' ? Math.max(...values) : Math.min(...values);
    const digits = digitsForMetric(firstVerdict.metric);
    return [firstVerdict.metric, ...values.map((value) => formatNumber(value, digits)), formatNumber(worst, digits), firstVerdict.limit, runs.every((run) => run.analysis.verdicts[verdictIndex].pass) ? 'PASS' : 'FAIL'];
  });
  console.log(`\nWorst value of each metric over ${runs.length} run(s); every run must pass:`);
  console.log(formatTable(['metric', ...runs.map((run) => `run ${run.runNumber}`), 'worst', 'limit', 'result'], worstRows, { rightAlignFrom: 1 }));
  const extraFailures = runs.flatMap((run) => [
    ...(run.gpuErrors.length ? [`run ${run.runNumber}: ${run.gpuErrors.length} GPU error(s)`] : []),
    ...(run.deviceLost ? [`run ${run.runNumber}: the GPU device was lost`] : []),
    ...(run.pageErrors.length ? [`run ${run.runNumber}: ${run.pageErrors.length} page error(s)`] : []),
  ]);
  for (const failure of extraFailures) console.log(`  ${failure}`);
  const allRunsPass = runs.length === runCount && runs.every((run) => run.analysis.pass) && !extraFailures.length;
  console.log(allRunsPass ? `\nflight PASSED: all ${runCount} run(s) met the pass rule.` : '\nflight FAILED: at least one run broke the pass rule (see FAIL above).');
  process.exit(allRunsPass ? 0 : 1);
}
