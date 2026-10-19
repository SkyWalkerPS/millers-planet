import { SuitController, locomotionSettings } from '../src/character/suitController.js';
import { SOLE_POINT_NAMES, SuitFigure, FOOT_EVENT_HEEL_STRIKE, cadenceStepsPerMinute, strideLengthMetres } from '../src/character/suitFigure.js';
import { createSeabedHeightFunction } from '../src/sea/seabedHeight.js';
import { defaultSeaSurfaceSettings } from '../src/sea/seaSurfaceSettings.js';
import { scriptedInputAt, scriptedWalk } from '../src/character/scriptedWalk.js';

const DRIFT_LIMIT_METRES = 0.02;
const REACH_LIMIT_METRES = 0.001;
const TOUCHDOWN_HEIGHT_LIMIT_METRES = 0.01;

export function createDriftTracker() {
  const references = [new Map(), new Map()];
  const tracker = {
    worstDriftMetres: 0,
    worstDriftDetail: null,
    stanceCount: 0,
    worstTouchdownHeightErrorMetres: 0,
    observe(feet, seconds) {
      for (let footIndex = 0; footIndex < 2; footIndex++) {
        const foot = feet[footIndex];
        const pointReferences = references[footIndex];
        if (!foot.inStance) {
          pointReferences.clear();
          continue;
        }
        const serialKey = foot.stanceSerial;
        for (let pointIndex = 0; pointIndex < 4; pointIndex++) {
          const key = `${serialKey}:${pointIndex}`;
          const inContact = (foot.contactMask & (1 << pointIndex)) !== 0;
          const point = foot.solePoints[pointIndex];
          if (!inContact) {
            pointReferences.delete(key);
            continue;
          }
          const reference = pointReferences.get(key);
          if (!reference) {
            pointReferences.set(key, [point[0], point[1], point[2]]);
            continue;
          }
          const drift = Math.hypot(point[0] - reference[0], point[1] - reference[1], point[2] - reference[2]);
          if (drift > tracker.worstDriftMetres) {
            tracker.worstDriftMetres = drift;
            tracker.worstDriftDetail = { foot: footIndex === 0 ? 'left' : 'right', point: SOLE_POINT_NAMES[pointIndex], stanceSerial: serialKey, seconds: Number(seconds.toFixed(3)) };
          }
        }
      }
    },
  };
  return tracker;
}

function telemetryFromFigure(figure) {
  return figure.feet.map((foot) => ({
    inStance: foot.planted,
    stanceSerial: foot.stanceSerial,
    contactMask: foot.contactMask,
    solePoints: [0, 1, 2, 3].map((index) => [foot.solePoints[index * 3], foot.solePoints[index * 3 + 1], foot.solePoints[index * 3 + 2]]),
  }));
}

export function runNodeSimulation({ deltaSecondsAt, durationSeconds = 27, script = scriptedWalk }) {
  const seabedHeightAt = createSeabedHeightFunction({
    meanDepthMetres: 0.2,
    depthVariationMetres: defaultSeaSurfaceSettings.seabedDepthVariationMetres,
    featureScalePerMetre: defaultSeaSurfaceSettings.seabedFeatureScalePerMetre,
  });
  const controller = new SuitController({ seabedHeightAt });
  const figure = new SuitFigure({ seabedHeightAt });
  controller.teleport(3.1, -2.4, 0);
  figure.teleport(controller);
  const tracker = createDriftTracker();
  let seconds = 0;
  let frame = 0;
  let worstTouchdownHeightError = 0;
  const heelStrikeTimes = [];
  const heelStrikePositions = [];
  const pelvisHeightsAtSteadyWalk = [];
  while (seconds < durationSeconds) {
    const deltaSeconds = deltaSecondsAt(frame);
    const input = scriptedInputAt(script, seconds);
    controller.update(deltaSeconds, input.moveRight, input.moveForward, input.shift, 0);
    figure.update(deltaSeconds, controller);
    seconds += deltaSeconds;
    frame++;
    tracker.observe(telemetryFromFigure(figure), seconds);
    for (let eventIndex = 0; eventIndex < figure.eventCount; eventIndex++) {
      if (figure.eventKinds[eventIndex] !== FOOT_EVENT_HEEL_STRIKE) {
        continue;
      }
      const x = figure.eventPositions[eventIndex * 3];
      const y = figure.eventPositions[eventIndex * 3 + 1];
      const z = figure.eventPositions[eventIndex * 3 + 2];
      worstTouchdownHeightError = Math.max(worstTouchdownHeightError, Math.abs(y - seabedHeightAt(x, z)));
      if (seconds > 5 && seconds < 8 && input.label === 'walk forward') {
        heelStrikeTimes.push(seconds);
        heelStrikePositions.push([x, z]);
      }
    }
    if (seconds > 5 && seconds < 8) {
      pelvisHeightsAtSteadyWalk.push(figure.pelvisPosition[1] - controller.positionY);
    }
  }
  let measuredCadence = null;
  let measuredStepLength = null;
  if (heelStrikeTimes.length >= 3) {
    const intervals = heelStrikeTimes.slice(1).map((time, index) => time - heelStrikeTimes[index]);
    measuredCadence = 60 / (intervals.reduce((sum, value) => sum + value, 0) / intervals.length);
    const lengths = heelStrikePositions.slice(1).map((position, index) => Math.abs(position[1] - heelStrikePositions[index][1]));
    measuredStepLength = lengths.reduce((sum, value) => sum + value, 0) / lengths.length;
  }
  const pelvisHighest = Math.max(...pelvisHeightsAtSteadyWalk);
  const pelvisLowest = Math.min(...pelvisHeightsAtSteadyWalk);
  return {
    frames: frame,
    worstDriftMetres: tracker.worstDriftMetres,
    worstDriftDetail: tracker.worstDriftDetail,
    maximumStanceReachExcessMetres: figure.maximumStanceReachExcessMetres,
    worstTouchdownHeightErrorMetres: worstTouchdownHeightError,
    stancesLeft: figure.feet[0].stanceSerial,
    stancesRight: figure.feet[1].stanceSerial,
    measuredCadence,
    expectedCadence: cadenceStepsPerMinute(locomotionSettings.walkSpeedMetresPerSecond),
    measuredStepLength,
    expectedStepLength: strideLengthMetres(locomotionSettings.walkSpeedMetresPerSecond) / 2,
    pelvisVaultMetres: pelvisHighest - pelvisLowest,
    finalPosition: [controller.positionX, controller.positionZ],
  };
}

async function runBrowserWalk() {
  const { openMillersPlanet, evidenceDirectory } = await import('./target.mjs');
  const { pageExpression } = await import('./page-results.mjs');
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const path = await import('node:path');
  const target = await openMillersPlanet({ query: { scale: '0.7' } });
  try {
    const result = await target.page.evaluate(pageExpression('window.millersPlanet.debug.runFootDriftWalk({})'), { timeoutMs: 600000 });
    const tracker = createDriftTracker();
    for (const sample of result.samples) tracker.observe(sample.feet, sample.seconds);
    const perStanceWorst = tracker.worstDriftMetres;
    const report = {
      frames: result.samples.length,
      worstSoleDriftMetres: perStanceWorst,
      worstDriftDetail: tracker.worstDriftDetail,
      maximumStanceReachExcessMetres: result.maximumStanceReachExcessMetres,
      stances: result.stances,
      gpuErrors: result.gpuErrors,
      pageErrors: target.page.pageErrors().map((event) => event.text),
    };
    const phase = Number(process.env.PHASE || 5);
    mkdirSync(evidenceDirectory(), { recursive: true });
    writeFileSync(path.join(evidenceDirectory(), `${phase}-foot-drift.json`), JSON.stringify(report, null, 2));
    const failed = report.worstSoleDriftMetres > DRIFT_LIMIT_METRES || report.maximumStanceReachExcessMetres > REACH_LIMIT_METRES || report.gpuErrors.length > 0 || report.pageErrors.length > 0;
    console.log(`browser (stats() feet every frame, ${report.frames} frames at 60 fps): ${failed ? 'FAIL' : 'PASS'}  worst sole drift ${(report.worstSoleDriftMetres * 100).toFixed(3)} cm ${JSON.stringify(report.worstDriftDetail)}, reach excess ${(report.maximumStanceReachExcessMetres * 100).toFixed(2)} cm, stances ${report.stances.join('/')}, GPU errors ${report.gpuErrors.length}, page errors ${report.pageErrors.length}`);
    return failed;
  } finally {
    await target.close();
  }
}

const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule && process.argv.includes('--browser')) {
  const failed = await runBrowserWalk();
  process.exit(failed ? 1 : 0);
}
if (isMainModule && !process.argv.includes('--browser')) {
  const variants = [
    ['60 fps', () => 1 / 60],
    ['30 fps', () => 1 / 30],
    ['120 fps', () => 1 / 120],
    ['jittered 50-70 fps', (frame) => 1 / (60 + 10 * Math.sin(frame * 12.9898) * Math.cos(frame * 4.1414))],
  ];
  let failed = false;
  for (const [label, deltaSecondsAt] of variants) {
    const result = runNodeSimulation({ deltaSecondsAt });
    const problems = [];
    if (result.worstDriftMetres > DRIFT_LIMIT_METRES) problems.push(`sole drift ${(result.worstDriftMetres * 100).toFixed(2)} cm > 2 cm (${JSON.stringify(result.worstDriftDetail)})`);
    if (result.maximumStanceReachExcessMetres > REACH_LIMIT_METRES) problems.push(`stance leg over-reached by ${(result.maximumStanceReachExcessMetres * 100).toFixed(2)} cm`);
    if (result.worstTouchdownHeightErrorMetres > TOUCHDOWN_HEIGHT_LIMIT_METRES) problems.push(`heel ${(result.worstTouchdownHeightErrorMetres * 100).toFixed(2)} cm off the seabed at touchdown`);
    if (result.measuredCadence !== null && Math.abs(result.measuredCadence / result.expectedCadence - 1) > 0.02) problems.push(`cadence ${result.measuredCadence.toFixed(1)} vs ${result.expectedCadence.toFixed(1)} steps/min`);
    failed ||= problems.length > 0;
    console.log(`${label}: ${problems.length ? 'FAIL' : 'PASS'}  drift ${(result.worstDriftMetres * 100).toFixed(3)} cm, reach excess ${(result.maximumStanceReachExcessMetres * 100).toFixed(2)} cm, touchdown height error ${(result.worstTouchdownHeightErrorMetres * 100).toFixed(2)} cm, stances ${result.stancesLeft}/${result.stancesRight}, cadence ${result.measuredCadence?.toFixed(1)} (expected ${result.expectedCadence.toFixed(1)}), step ${result.measuredStepLength?.toFixed(3)} m (expected ${result.expectedStepLength.toFixed(3)}), pelvis vault ${(result.pelvisVaultMetres * 100).toFixed(1)} cm, final position ${result.finalPosition.map((value) => value.toFixed(2)).join(', ')}`);
    for (const problem of problems) console.log(`  ${problem}`);
  }
  process.exit(failed ? 1 : 0);
}
