import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { evidenceDirectory, openMillersPlanet, waitForMillersPlanetReady } from './target.mjs';
import { pageExpression } from './page-results.mjs';
import { waveLocalShapeAt } from '../src/wave/waveLocalShape.js';

const phase = Number(process.env.PHASE || 7);
const waveCount = Number(process.env.WAVES || 5);
const shotPhases = [
  { name: 'a', waveSeconds: -59, label: 'approach (T-59)' },
  { name: 'b', waveSeconds: -5, label: 'brace (T-5)' },
  { name: 'c', waveSeconds: 2, label: 'underwater (T+2)' },
  { name: 'd', waveSeconds: 8, label: 'drain (T+8)' },
  { name: 'after', waveSeconds: 15, label: 'after (T+15)' },
];
const leadSeconds = 2.5;
const cameraBlendWindows = [[-8.6, -6.0], [4.4, 11.0]];
const cameraBlendStepFrames = 6;
const cameraBlendMinimumHelmetDistanceMetres = 0.8;
const parityLateralCount = 1024;
const parityLateralRangeMetres = 20000;
const parityCrestOffsetToleranceMetres = 0.05;
const parityHeightScaleTolerance = 1e-4;
const lateralSearchRangeMetres = 20000;
const problems = [];
const report = { waves: [], reload: null };
mkdirSync(evidenceDirectory(), { recursive: true });

const target = await openMillersPlanet({ query: { scale: '0.7' } });
try {
  const { page } = target;
  await page.evaluate(pageExpression(`(async () => { window.millersPlanet.debug.enterPlayerMode(); window.millersPlanet.freezeTime(null); return true; })()`));
  for (let waveIndex = 1; waveIndex <= waveCount; waveIndex++) {
    const waveRecord = { waveIndex, phases: [] };
    for (const shotPhase of shotPhases) {
      const state = await page.evaluate(pageExpression(`(async () => {
        const api = window.millersPlanet;
        api.freezeTime(null);
        const impact = ${300 * waveIndex};
        const targetSeconds = impact + ${shotPhase.waveSeconds};
        const skip = api.skipTo({ waveIndex: ${waveIndex}, phase: 'impact', secondsIntoPhase: ${shotPhase.waveSeconds - leadSeconds} });
        await api.renderFrames(${Math.round(leadSeconds * 60)});
        api.freezeTime(targetSeconds);
        await api.renderFrames(50);
        const stats = api.stats();
        return {
          requested: targetSeconds,
          clock: stats.clocks.millerSeconds,
          wave: { index: stats.wave.index, phase: stats.wave.phase, secondsIntoPhase: stats.wave.secondsIntoPhase, underwater: stats.wave.cameraUnderwater, impactPosition: stats.wave.impactPosition, impactWaveIndex: stats.wave.impactWaveIndex, keyLightVisibility: stats.wave.keyLightVisibility },
          ship: stats.ship,
          astronaut: { position: stats.astronaut.position, braced: stats.astronaut.braced, inputLocked: stats.astronaut.inputLocked },
          camera: { scriptedWeight: stats.camera.scriptedWeight, preset: stats.camera.preset },
          gpuErrors: stats.gpuErrors,
        };
      })()`), { timeoutMs: 120000 });
      const fileName = `${phase}-wave-run-${waveIndex}-${shotPhase.name}.png`;
      await page.screenshot(path.join(evidenceDirectory(), fileName));
      waveRecord.phases.push({ phase: shotPhase.name, label: shotPhase.label, file: fileName, ...state });
      if (state.gpuErrors.length) problems.push(`wave ${waveIndex} ${shotPhase.name}: GPU errors ${state.gpuErrors.join(' | ')}`);
    }
    const blendSamples = await page.evaluate(pageExpression(`(async () => {
      const api = window.millersPlanet;
      const impact = ${300 * waveIndex};
      const samples = [];
      for (const [startSeconds, endSeconds] of ${JSON.stringify(cameraBlendWindows)}) {
        api.freezeTime(null);
        api.skipTo({ waveIndex: ${waveIndex}, phase: 'impact', secondsIntoPhase: startSeconds });
        const stepCount = Math.round((endSeconds - startSeconds) * 60 / ${cameraBlendStepFrames});
        for (let step = 0; step <= stepCount; step++) {
          await api.renderFrames(step === 0 ? 1 : ${cameraBlendStepFrames});
          const stats = api.stats();
          samples.push({ waveSeconds: stats.clocks.millerSeconds - impact, phase: stats.wave.phase, weight: stats.camera.scriptedWeight, armLengthMetres: stats.camera.distance, helmet: stats.camera.helmet });
        }
      }
      return samples;
    })()`), { timeoutMs: 300000 });
    const scriptedSamples = blendSamples.filter((sample) => sample.weight > 0);
    const outOfView = scriptedSamples.filter((sample) => !sample.helmet.inView);
    const tooClose = scriptedSamples.filter((sample) => sample.armLengthMetres > 0.5 && sample.helmet.distanceMetres < cameraBlendMinimumHelmetDistanceMetres);
    const closest = scriptedSamples.reduce((best, sample) => (sample.helmet.distanceMetres < best.helmet.distanceMetres ? sample : best), scriptedSamples[0]);
    waveRecord.cameraBlend = { samples: blendSamples.length, scriptedSamples: scriptedSamples.length, outOfView: outOfView.length, tooClose: tooClose.length, closestHelmetMetres: closest?.helmet.distanceMetres ?? null, closestAtWaveSeconds: closest?.waveSeconds ?? null };
    const describeSample = (sample) => `T${sample.waveSeconds >= 0 ? '+' : ''}${sample.waveSeconds.toFixed(1)} s (${sample.phase}, weight ${sample.weight.toFixed(2)}, helmet ${sample.helmet.distanceMetres.toFixed(2)} m away${sample.helmet.screen ? ` at ${sample.helmet.screen.map((value) => value.toFixed(2)).join(', ')}` : ', behind the camera'})`;
    if (outOfView.length) problems.push(`wave ${waveIndex} camera blend: the helmet is out of view in ${outOfView.length} of ${scriptedSamples.length} scripted samples, first at ${describeSample(outOfView[0])}`);
    if (tooClose.length) problems.push(`wave ${waveIndex} camera blend: the camera comes within ${cameraBlendMinimumHelmetDistanceMetres} m of the helmet in ${tooClose.length} samples, closest at ${describeSample(closest)}`);
    console.log(`wave ${waveIndex} camera blend: ${scriptedSamples.length} scripted samples, helmet out of view in ${outOfView.length}, closest ${closest ? `${closest.helmet.distanceMetres.toFixed(2)} m at T${closest.waveSeconds >= 0 ? '+' : ''}${closest.waveSeconds.toFixed(1)} s` : 'n/a'}`);
    const afterRecord = waveRecord.phases[waveRecord.phases.length - 1];
    const expectedState = Math.min(waveIndex, 4);
    if (afterRecord.ship.state !== expectedState) problems.push(`after wave ${waveIndex} the ship state is ${afterRecord.ship.state} (expected ${expectedState})`);
    if ((expectedState === 4) === afterRecord.ship.visible) problems.push(`after wave ${waveIndex} the ship visible flag is ${afterRecord.ship.visible}`);
    if (afterRecord.wave.impactWaveIndex !== waveIndex) problems.push(`wave ${waveIndex}: the recorded impact belongs to wave ${afterRecord.wave.impactWaveIndex}`);
    if (expectedState < 4 && afterRecord.wave.impactPosition) {
      const [impactX, impactZ] = afterRecord.wave.impactPosition;
      const distance = Math.hypot(afterRecord.ship.position[0] - impactX, afterRecord.ship.position[1] - impactZ);
      waveRecord.shipDistanceFromImpactMetres = distance;
      if (distance < 100 || distance > 150) problems.push(`after wave ${waveIndex} the ship is ${distance.toFixed(1)} m from the impact position (expected 100-150)`);
      const view = await page.evaluate(pageExpression(`(async () => {
        const api = window.millersPlanet;
        const [impactX, impactZ] = ${JSON.stringify(afterRecord.wave.impactPosition)};
        const ship = api.stats().ship;
        const bearing = Math.atan2(ship.position[0] - impactX, ship.position[1] - impactZ) * 180 / Math.PI;
        api.debug.setAstronautPosition({ x: impactX, z: impactZ, yawDegrees: bearing + 25, cameraYawDegrees: bearing });
        await api.renderFrames(60);
        return { bearingDegrees: bearing, astronaut: api.stats().astronaut.position };
      })()`));
      const viewFile = `${phase}-ship-${waveIndex}-from-impact.png`;
      await page.screenshot(path.join(evidenceDirectory(), viewFile));
      waveRecord.fromImpact = { file: viewFile, ...view };
    }
    for (const record of waveRecord.phases) {
      const expectations = { a: ['approach'], b: ['brace'], c: ['underwater'], d: ['drain'], after: ['calm'] };
      if (!expectations[record.phase].includes(record.wave.phase)) problems.push(`wave ${waveIndex} ${record.phase}: the page is in phase ${record.wave.phase}`);
      if (record.phase === 'b' && (!record.astronaut.braced || !record.astronaut.inputLocked)) problems.push(`wave ${waveIndex} brace: braced ${record.astronaut.braced}, input locked ${record.astronaut.inputLocked}`);
      if (record.phase === 'c' && !record.wave.underwater) problems.push(`wave ${waveIndex} underwater: the camera is not under water`);
      if (record.phase === 'after' && (record.astronaut.inputLocked || record.camera.scriptedWeight > 0)) problems.push(`wave ${waveIndex} after: input locked ${record.astronaut.inputLocked}, scripted camera ${record.camera.scriptedWeight}`);
    }
    report.waves.push(waveRecord);
    console.log(`wave ${waveIndex}: phases ${waveRecord.phases.map((record) => `${record.phase}=${record.wave.phase}`).join(', ')}; ship after: ${afterRecord.ship.stateName}${waveRecord.shipDistanceFromImpactMetres ? `, ${waveRecord.shipDistanceFromImpactMetres.toFixed(1)} m from the impact` : ''}`);
  }
  const parityLaterals = Array.from({ length: parityLateralCount }, (_, index) => -parityLateralRangeMetres + (index * 2 * parityLateralRangeMetres) / (parityLateralCount - 1));
  const parity = await page.evaluate(pageExpression(`window.millersPlanet.debug.waveShapeParity(${JSON.stringify(parityLaterals)})`), { timeoutMs: 60000 });
  report.waveShapeParity = parity;
  console.log(`wave shape parity (JS against WGSL, ${parity.samples} laterals over ±${parityLateralRangeMetres / 1000} km): crest offset error ${parity.largestCrestOffsetErrorMetres.toExponential(2)} m, height scale error ${parity.largestHeightScaleError.toExponential(2)}, largest crest offset ${parity.largestCrestOffsetMetres.toFixed(1)} m`);
  if (parity.gpuErrors || parity.largestCrestOffsetErrorMetres > parityCrestOffsetToleranceMetres || parity.largestHeightScaleError > parityHeightScaleTolerance) {
    problems.push(`wave shape parity: crest offset error ${parity.largestCrestOffsetErrorMetres} m (limit ${parityCrestOffsetToleranceMetres}), height scale error ${parity.largestHeightScaleError} (limit ${parityHeightScaleTolerance}), GPU errors ${parity.gpuErrors}`);
  }
  const offsets = [];
  for (let lateral = -lateralSearchRangeMetres; lateral <= lateralSearchRangeMetres; lateral += 5) offsets.push({ lateral, offset: waveLocalShapeAt(lateral, {}).crestOffsetMetres });
  const worstLateral = offsets.reduce((best, entry) => (Math.abs(entry.offset) > Math.abs(best.offset) ? entry : best));
  const calmestLateral = offsets.reduce((best, entry) => (Math.abs(entry.offset) < Math.abs(best.offset) ? entry : best));
  const scheduleWaveIndex = waveCount + 1;
  const scheduleChecks = [];
  for (const place of [calmestLateral, worstLateral]) {
    const result = await page.evaluate(pageExpression(`(async () => {
      const api = window.millersPlanet;
      const impact = ${300 * scheduleWaveIndex};
      const placeAtLateral = () => {
        const wave = api.stats().wave;
        const [towardX, towardZ] = wave.toward;
        const fromOrigin = ${place.lateral} - wave.lateralOriginMetres;
        api.debug.setAstronautPosition({ x: towardZ * fromOrigin, z: -towardX * fromOrigin, yawDegrees: Math.atan2(towardX, towardZ) * 180 / Math.PI });
      };
      api.freezeTime(null);
      placeAtLateral();
      await api.renderFrames(2);
      placeAtLateral();
      api.freezeTime(impact);
      await api.renderFrames(2);
      const atImpact = api.stats().wave.astronautCrest;
      const findSwitch = async (fromSeconds, toSeconds, wantUnderwater) => {
        api.freezeTime(null);
        api.skipTo({ waveIndex: ${scheduleWaveIndex}, phase: 'impact', secondsIntoPhase: fromSeconds });
        await api.renderFrames(1);
        for (let frame = 0; frame < Math.round((toSeconds - fromSeconds) * 60); frame++) {
          await api.renderFrames(1);
          const stats = api.stats();
          if (stats.wave.cameraUnderwater === wantUnderwater) return stats.clocks.millerSeconds - impact;
        }
        return null;
      };
      const underwaterFrom = await findSwitch(-0.6, 0.8, true);
      const underwaterUntil = await findSwitch(4.3, 5.8, false);
      return { atImpact, underwaterFrom, underwaterUntil };
    })()`), { timeoutMs: 180000 });
    scheduleChecks.push({ lateralMetres: place.lateral, expectedCrestOffsetMetres: place.offset, ...result });
  }
  report.lateralSchedule = scheduleChecks;
  const frontWidthMetres = 350;
  for (const check of scheduleChecks) {
    console.log(`lateral ${check.lateralMetres} m (crest offset ${check.expectedCrestOffsetMetres.toFixed(1)} m): at T the local crest is ${check.atImpact.aheadMetres.toFixed(1)} m ahead of the astronaut (toe at the astronaut = ${frontWidthMetres} m), under water from T${check.underwaterFrom === null ? ' never' : `+${check.underwaterFrom.toFixed(3)} s`} until T${check.underwaterUntil === null ? ' never' : `+${check.underwaterUntil.toFixed(3)} s`}`);
    if (Math.abs(check.atImpact.aheadMetres - frontWidthMetres) > 1) problems.push(`lateral ${check.lateralMetres} m: at T the local crest is ${check.atImpact.aheadMetres.toFixed(1)} m ahead of the astronaut, not ${frontWidthMetres} m, so the wave hits ${((frontWidthMetres - check.atImpact.aheadMetres) / 200).toFixed(2)} s off the schedule`);
    if (check.underwaterFrom === null || check.underwaterUntil === null) problems.push(`lateral ${check.lateralMetres} m: the camera never switched ${check.underwaterFrom === null ? 'under' : 'out of the'} water`);
  }
  const [calmest, worst] = scheduleChecks;
  if (calmest.underwaterFrom !== null && worst.underwaterFrom !== null && calmest.underwaterUntil !== null && worst.underwaterUntil !== null) {
    const startDifference = Math.abs(worst.underwaterFrom - calmest.underwaterFrom);
    const endDifference = Math.abs(worst.underwaterUntil - calmest.underwaterUntil);
    if (startDifference > 0.05 || endDifference > 0.05) problems.push(`the underwater view starts ${startDifference.toFixed(3)} s and ends ${endDifference.toFixed(3)} s apart between laterals ${calmest.lateralMetres} m and ${worst.lateralMetres} m (limit 0.05 s)`);
  }
  await page.reload();
  await waitForMillersPlanetReady(page);
  report.reload = await page.evaluate(pageExpression(`(() => {
    const stats = window.millersPlanet.stats();
    return { clock: stats.clocks.millerSeconds, wave: { index: stats.wave.index, phase: stats.wave.phase }, ship: { state: stats.ship.state, distance: stats.ship.distanceFromAstronautMetres }, astronaut: stats.astronaut.position, origin: stats.origin };
  })()`));
  const reload = report.reload;
  if (reload.clock > 5 || reload.wave.index !== 1 || reload.wave.phase !== 'calm' || reload.ship.state !== 0 || reload.ship.distance < 15 || reload.ship.distance > 25 || Math.hypot(reload.astronaut[0], reload.astronaut[2]) > 0.01 || reload.origin.shifts !== 0) {
    problems.push(`after a reload: clock ${reload.clock.toFixed(1)} s, wave ${reload.wave.index} ${reload.wave.phase}, ship state ${reload.ship.state} at ${reload.ship.distance.toFixed(1)} m, astronaut at ${reload.astronaut.map((value) => value.toFixed(2)).join(', ')}, origin shifts ${reload.origin.shifts}`);
  }
  console.log(`reload: clock ${reload.clock.toFixed(2)} s, wave ${reload.wave.index} ${reload.wave.phase}, ship state ${reload.ship.state} at ${reload.ship.distance.toFixed(1)} m`);
  const pageErrors = page.pageErrors();
  if (pageErrors.length) problems.push(`page errors: ${pageErrors.map((event) => event.text).join(' | ')}`);
} finally {
  await target.close();
}
writeFileSync(path.join(evidenceDirectory(), `${phase}-wave-run.json`), JSON.stringify({ ...report, problems }, null, 2));
console.log(problems.length ? `FAIL\n  ${problems.join('\n  ')}` : 'PASS');
process.exit(problems.length ? 1 : 0);
