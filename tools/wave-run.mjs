import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { evidenceDirectory, openMillersPlanet, waitForMillersPlanetReady } from './target.mjs';
import { pageExpression } from './page-results.mjs';
import { waveLocalShapeAt } from '../src/wave/waveLocalShape.js';
import { impactSecondsOf, waveSchedule } from '../src/wave/waveTimeline.js';
import { waveRideSettings } from '../src/wave/waveRide.js';

const phase = Number(process.env.PHASE || 7);
const waveCount = Number(process.env.WAVES || 5);
const settleSeconds = waveSchedule.rideSeconds + waveSchedule.drainSeconds;
const crestSeconds = waveRideSettings.crestCrossingSeconds;
const shotPhases = [
  { name: 'a', waveSeconds: -59, label: 'approach (T-59)' },
  { name: 'b', waveSeconds: -5, label: 'brace (T-5)' },
  { name: 'c', waveSeconds: crestSeconds, label: `ride over the crest (T+${crestSeconds})` },
  { name: 'd', waveSeconds: waveSchedule.rideSeconds + 2, label: `drain (T+${waveSchedule.rideSeconds + 2})` },
  { name: 'after', waveSeconds: settleSeconds + 4, label: `after (T+${settleSeconds + 4})` },
];
const leadSeconds = 2.5;
const cameraBlendWindows = [[-8.6, -6.0], [waveSchedule.rideSeconds - 0.1, settleSeconds]];
const crestLiftMinimumMetres = 2200;
const cameraBlendStepFrames = 6;
const cameraBlendMinimumHelmetDistanceMetres = 0.8;
const parityLateralCount = 1024;
const parityLateralRangeMetres = 20000;
const parityCrestOffsetToleranceMetres = 0.05;
const parityHeightScaleTolerance = 1e-4;
const lateralSearchRangeMetres = 20000;
const recedingSampleSeconds = [settleSeconds - 0.05, settleSeconds + 0.05, 30, 60, 100, 150, 235, 240, 250];
const passingSpeedMetresPerSecond = 200;
const fullWaveHeightMetres = 2400;
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
        const impact = ${impactSecondsOf(waveIndex)};
        const targetSeconds = impact + ${shotPhase.waveSeconds};
        const skip = api.skipTo({ waveIndex: ${waveIndex}, phase: 'impact', secondsIntoPhase: ${shotPhase.waveSeconds - leadSeconds} });
        await api.renderFrames(${Math.round(leadSeconds * 60)});
        api.freezeTime(targetSeconds);
        await api.renderFrames(50);
        const stats = api.stats();
        const app = api.debug.application;
        const anchor = stats.wave.anchor;
        return {
          requested: targetSeconds,
          ride: stats.wave.ride,
          crossing: stats.wave.waterCrossingAmount,
          landing: anchor && anchor.index === ${waveIndex} ? app.rideLandingPoint(anchor.x, anchor.z) : null,
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
    const afterRecord = waveRecord.phases[waveRecord.phases.length - 1];
    const expectedState = Math.min(waveIndex, 4);
    if (afterRecord.ship.state !== expectedState) problems.push(`after wave ${waveIndex} the ship state is ${afterRecord.ship.state} (expected ${expectedState})`);
    if ((expectedState === 4) === afterRecord.ship.visible) problems.push(`after wave ${waveIndex} the ship visible flag is ${afterRecord.ship.visible}`);
    if (afterRecord.wave.impactWaveIndex !== waveIndex) problems.push(`wave ${waveIndex}: the recorded impact belongs to wave ${afterRecord.wave.impactWaveIndex}`);
    const drainRecord = waveRecord.phases.find((record) => record.phase === 'd');
    if (expectedState < 4 && drainRecord.landing) {
      const [landingX, landingZ] = drainRecord.landing;
      const distance = Math.hypot(afterRecord.ship.position[0] - landingX, afterRecord.ship.position[1] - landingZ);
      waveRecord.shipDistanceFromLandingMetres = distance;
      if (distance < 100 || distance > 150) problems.push(`after wave ${waveIndex} the ship is ${distance.toFixed(1)} m from the astronaut's landing point (expected 100-150)`);
      const view = await page.evaluate(pageExpression(`(async () => {
        const api = window.millersPlanet;
        const [impactX, impactZ] = ${JSON.stringify(drainRecord.landing)};
        const ship = api.stats().ship;
        const bearing = Math.atan2(ship.position[0] - impactX, ship.position[1] - impactZ) * 180 / Math.PI;
        api.debug.setAstronautPosition({ x: impactX, z: impactZ, yawDegrees: bearing + 25, cameraYawDegrees: bearing });
        await api.renderFrames(60);
        return { bearingDegrees: bearing, astronaut: api.stats().astronaut.position };
      })()`));
      const viewFile = `${phase}-ship-${waveIndex}-from-landing.png`;
      await page.screenshot(path.join(evidenceDirectory(), viewFile));
      waveRecord.fromLanding = { file: viewFile, ...view };
    }
    const blendSamples = await page.evaluate(pageExpression(`(async () => {
      const api = window.millersPlanet;
      const impact = ${impactSecondsOf(waveIndex)};
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
    for (const record of waveRecord.phases) {
      const expectations = { a: ['approach'], b: ['brace'], c: ['ride'], d: ['drain'], after: ['calm'] };
      if (!expectations[record.phase].includes(record.wave.phase)) problems.push(`wave ${waveIndex} ${record.phase}: the page is in phase ${record.wave.phase}`);
      if (record.phase === 'b' && (!record.astronaut.braced || !record.astronaut.inputLocked)) problems.push(`wave ${waveIndex} brace: braced ${record.astronaut.braced}, input locked ${record.astronaut.inputLocked}`);
      if (record.phase === 'c' && (!record.ride.active || record.ride.liftMetres < crestLiftMinimumMetres)) problems.push(`wave ${waveIndex} ride: at the crest the astronaut is ${record.ride.active ? `${record.ride.liftMetres.toFixed(0)} m up` : 'not riding'} (expected above ${crestLiftMinimumMetres} m)`);
      if (record.phase === 'c' && (record.wave.underwater || record.crossing > 0.01)) problems.push(`wave ${waveIndex} ride: at the crest the camera is ${record.wave.underwater ? 'under water' : `showing the water-crossing wipe (${record.crossing.toFixed(2)})`}`);
      if (record.phase === 'd' && (!record.landing || Math.hypot(record.astronaut.position[0] - record.landing[0], record.astronaut.position[2] - record.landing[1]) > 1)) problems.push(`wave ${waveIndex} drain: the astronaut is at ${record.astronaut.position.map((value) => value.toFixed(1)).join(', ')}, not at the landing point ${record.landing ? record.landing.map((value) => value.toFixed(1)).join(', ') : 'unknown'}`);
      if (record.phase === 'after' && (record.astronaut.inputLocked || record.camera.scriptedWeight > 0)) problems.push(`wave ${waveIndex} after: input locked ${record.astronaut.inputLocked}, scripted camera ${record.camera.scriptedWeight}`);
    }
    report.waves.push(waveRecord);
    console.log(`wave ${waveIndex}: phases ${waveRecord.phases.map((record) => `${record.phase}=${record.wave.phase}`).join(', ')}; lift at the crest ${waveRecord.phases[2].ride.liftMetres.toFixed(0)} m; ship after: ${afterRecord.ship.stateName}${waveRecord.shipDistanceFromLandingMetres ? `, ${waveRecord.shipDistanceFromLandingMetres.toFixed(1)} m from the landing point` : ''}`);
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
      const impact = ${impactSecondsOf(scheduleWaveIndex)};
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
      api.freezeTime(null);
      api.skipTo({ waveIndex: ${scheduleWaveIndex}, phase: 'impact', secondsIntoPhase: -0.5 });
      await api.renderFrames(1);
      const ride = { frames: 0, underwaterFrames: 0, firstUnderwaterSeconds: null, largestCrossing: 0, largestLiftMetres: 0, largestLiftAtSeconds: null };
      for (let frame = 0; frame < Math.round((${waveSchedule.rideSeconds} + 1) * 60); frame++) {
        await api.renderFrames(1);
        const stats = api.stats();
        const waveSeconds = stats.clocks.millerSeconds - impact;
        ride.frames++;
        if (stats.wave.cameraUnderwater) {
          ride.underwaterFrames++;
          if (ride.firstUnderwaterSeconds === null) ride.firstUnderwaterSeconds = waveSeconds;
        }
        ride.largestCrossing = Math.max(ride.largestCrossing, stats.wave.waterCrossingAmount);
        if (stats.wave.ride.active && stats.wave.ride.liftMetres > ride.largestLiftMetres) {
          ride.largestLiftMetres = stats.wave.ride.liftMetres;
          ride.largestLiftAtSeconds = waveSeconds;
        }
      }
      return { atImpact, ride };
    })()`), { timeoutMs: 180000 });
    scheduleChecks.push({ lateralMetres: place.lateral, expectedCrestOffsetMetres: place.offset, ...result });
  }
  report.lateralSchedule = scheduleChecks;
  const frontWidthMetres = 350;
  for (const check of scheduleChecks) {
    console.log(`lateral ${check.lateralMetres} m (crest offset ${check.expectedCrestOffsetMetres.toFixed(1)} m): at T the local crest is ${check.atImpact.aheadMetres.toFixed(1)} m ahead of the astronaut (toe at the astronaut = ${frontWidthMetres} m); over ${check.ride.frames} ride frames the camera was under water in ${check.ride.underwaterFrames}, the largest wipe was ${check.ride.largestCrossing.toFixed(3)}, the highest lift ${check.ride.largestLiftMetres.toFixed(0)} m at T+${check.ride.largestLiftAtSeconds?.toFixed(2)} s`);
    if (Math.abs(check.atImpact.aheadMetres - frontWidthMetres) > 1) problems.push(`lateral ${check.lateralMetres} m: at T the local crest is ${check.atImpact.aheadMetres.toFixed(1)} m ahead of the astronaut, not ${frontWidthMetres} m, so the wave hits ${((frontWidthMetres - check.atImpact.aheadMetres) / 200).toFixed(2)} s off the schedule`);
    if (check.ride.underwaterFrames > 0) problems.push(`lateral ${check.lateralMetres} m: the ride camera went under water in ${check.ride.underwaterFrames} frames, first at T+${check.ride.firstUnderwaterSeconds.toFixed(3)} s`);
    if (check.ride.largestCrossing > 0.01) problems.push(`lateral ${check.lateralMetres} m: the water-crossing wipe showed during the ride (largest ${check.ride.largestCrossing.toFixed(3)})`);
    if (check.ride.largestLiftMetres < crestLiftMinimumMetres) problems.push(`lateral ${check.lateralMetres} m: the astronaut only rose ${check.ride.largestLiftMetres.toFixed(0)} m (expected above ${crestLiftMinimumMetres} m)`);
  }
  const recedingSamples = await page.evaluate(pageExpression(`(async () => {
    const api = window.millersPlanet;
    const impact = ${impactSecondsOf(1)};
    api.freezeTime(null);
    api.debug.setAstronautPosition({ x: 0, z: 0, yawDegrees: 0 });
    const samples = [];
    for (const secondsAfterImpact of ${JSON.stringify(recedingSampleSeconds)}) {
      api.freezeTime(impact + secondsAfterImpact);
      await api.renderFrames(2);
      const stats = api.stats();
      const [towardX, towardZ] = stats.wave.toward;
      const astronautAlong = stats.astronaut.position[0] * towardX + stats.astronaut.position[2] * towardZ;
      samples.push({ secondsAfterImpact, incoming: { visible: stats.wave.visible, crestAheadMetres: stats.wave.crestAlongMetres - astronautAlong, heightMetres: stats.wave.heightMetres }, receding: { ...stats.wave.receding, crestAheadMetres: stats.wave.receding.crestAlongMetres - astronautAlong } });
    }
    api.freezeTime(null);
    return samples;
  })()`), { timeoutMs: 120000 });
  report.recedingWave = recedingSamples;
  const sampleAt = (seconds) => recedingSamples.find((sample) => sample.secondsAfterImpact === seconds);
  const beforeHandOver = sampleAt(settleSeconds - 0.05);
  const afterHandOver = sampleAt(settleSeconds + 0.05);
  if (beforeHandOver.receding.visible) problems.push(`receding wave: visible before the passed wave hands over (T+${settleSeconds - 0.05})`);
  if (!afterHandOver.receding.visible) problems.push(`receding wave: not visible after the hand-over (T+${settleSeconds + 0.05})`);
  const handOverJump = afterHandOver.receding.crestAheadMetres - (beforeHandOver.incoming.crestAheadMetres - passingSpeedMetresPerSecond * 0.1);
  if (Math.abs(handOverJump) > 2) problems.push(`receding wave: the crest jumps ${handOverJump.toFixed(1)} m at the hand-over`);
  if (afterHandOver.incoming.heightMetres > 5) problems.push(`the next wave starts ${afterHandOver.incoming.heightMetres.toFixed(0)} m tall instead of rising from the sea`);
  for (const seconds of [30, 100]) {
    const sample = sampleAt(seconds);
    const expectedAhead = afterHandOver.receding.crestAheadMetres - passingSpeedMetresPerSecond * (seconds - afterHandOver.secondsAfterImpact);
    if (!sample.receding.visible || Math.abs(sample.receding.crestAheadMetres - expectedAhead) > 3) problems.push(`receding wave at T+${seconds}: visible ${sample.receding.visible}, crest ${sample.receding.crestAheadMetres.toFixed(0)} m ahead (expected ${expectedAhead.toFixed(0)})`);
  }
  if (Math.abs(sampleAt(150).receding.heightMetres - fullWaveHeightMetres) > 1) problems.push(`receding wave at T+150 (30 km): ${sampleAt(150).receding.heightMetres.toFixed(0)} m tall (expected full height)`);
  if (Math.abs(sampleAt(235).receding.heightMetres - fullWaveHeightMetres / 2) > fullWaveHeightMetres * 0.05) problems.push(`receding wave at T+235 (47 km): ${sampleAt(235).receding.heightMetres.toFixed(0)} m tall (expected about half height while sinking)`);
  const atNextImpact = sampleAt(240).receding;
  if (!atNextImpact.visible || atNextImpact.heightMetres < 400 || atNextImpact.heightMetres > 900) problems.push(`when the next wave hits (T+240), the passed wave is ${atNextImpact.visible ? `${atNextImpact.heightMetres.toFixed(0)} m tall` : 'hidden'} (expected a small ridge, 400-900 m)`);
  if (sampleAt(250).receding.visible) problems.push('receding wave at T+250: still drawn after sinking');
  if (Math.abs(sampleAt(60).incoming.heightMetres - fullWaveHeightMetres) > 1) problems.push(`the next wave at T+60 is ${sampleAt(60).incoming.heightMetres.toFixed(0)} m tall (expected full height)`);
  for (const sample of recedingSamples) console.log(`T+${sample.secondsAfterImpact} s: next wave ${sample.incoming.visible ? `${(sample.incoming.crestAheadMetres / 1000).toFixed(2)} km ahead, ${sample.incoming.heightMetres.toFixed(0)} m tall` : 'hidden'}; passed wave ${sample.receding.visible ? `${(-sample.receding.crestAheadMetres / 1000).toFixed(2)} km behind, ${sample.receding.heightMetres.toFixed(0)} m tall` : 'hidden'}`);

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
