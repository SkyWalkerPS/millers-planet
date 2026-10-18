import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { evidenceDirectory, openMillersPlanet } from './target.mjs';
import { pageExpression } from './page-results.mjs';
import { withImageWorkbench } from './image-workbench.mjs';

const phase = Number(process.env.PHASE || 6);
const forcedShiftMetres = Number(process.env.SHIFT_METRES || 1024);
const plantedFault = forcedShiftMetres % 1024 !== 0;
const controlRun = forcedShiftMetres === 0;
const filePrefix = controlRun ? `${phase}-origin-control` : plantedFault ? `${phase}-origin-planted-fault` : `${phase}-origin`;
const astronautBeforeShift = [990, 37];
const walkStart = [996, -20];
const walkFrames = 540;
const settleFrames = 120;
const tileEdgePixels = 32;
const problems = [];

mkdirSync(evidenceDirectory(), { recursive: true });
const imagePaths = {
  before: path.join(evidenceDirectory(), `${filePrefix}-before.png`),
  beforeRepeat: path.join(evidenceDirectory(), `${filePrefix}-before-repeat.png`),
  after: path.join(evidenceDirectory(), `${filePrefix}-after.png`),
  difference: path.join(evidenceDirectory(), `${filePrefix}-difference.png`),
};

const target = await openMillersPlanet({ query: { scale: '0.7' } });
let staticView;
let walk;
try {
  const page = target.page;
  staticView = await page.evaluate(pageExpression(`(async () => {
    const api = window.millersPlanet;
    api.debug.enterPlayerMode();
    const opening = api.stats();
    const shipOffset = [opening.ship.position[0] - opening.astronaut.position[0], opening.ship.position[1] - opening.astronaut.position[2]];
    const [x, z] = ${JSON.stringify(astronautBeforeShift)};
    api.freezeTime(754);
    api.debug.setAstronautPosition({ x, z, yawDegrees: opening.astronaut.headingDegrees, cameraYawDegrees: opening.camera.rigYawDegrees });
    api.debug.placeShip({ x: x + shipOffset[0], z: z + shipOffset[1], yawDegrees: opening.ship.yawDegrees, state: 1 });
    const heading = opening.astronaut.headingDegrees * Math.PI / 180;
    api.debug.stampRipple({ x: x + Math.sin(heading) * 1.6, z: z + Math.cos(heading) * 1.6, radius: 0.12, elongation: 1, forwardX: 1, forwardZ: 0, heightChange: 0.03, foam: 0.3, ringWeight: 0.48 });
    api.freezeTime(null);
    await api.renderFrames(60);
    api.freezeTime(api.stats().clocks.millerSeconds);
    await api.renderFrames(${settleFrames});
    const stats = api.stats();
    return { origin: stats.origin, astronaut: stats.astronaut.position, absolute: stats.astronaut.absolutePosition, camera: stats.camera.position, ship: stats.ship };
  })()`));
  await page.screenshot(imagePaths.before);
  await page.evaluate(`window.millersPlanet.renderFrames(${settleFrames}).then(() => true)`);
  await page.screenshot(imagePaths.beforeRepeat);
  staticView.afterShift = await page.evaluate(pageExpression(`(async () => {
    const api = window.millersPlanet;
    api.debug.shiftWorldOrigin(${forcedShiftMetres}, 0);
    await api.renderFrames(${settleFrames});
    const stats = api.stats();
    return { origin: stats.origin, astronaut: stats.astronaut.position, absolute: stats.astronaut.absolutePosition, camera: stats.camera.position, ship: stats.ship };
  })()`));
  await page.screenshot(imagePaths.after);

  if (!plantedFault && !controlRun) {
    walk = await page.evaluate(pageExpression(`(async () => {
      const api = window.millersPlanet;
      api.setCameraShot('astro-third');
      api.debug.enterPlayerMode();
      api.freezeTime(null);
      const [x, z] = ${JSON.stringify(walkStart)};
      api.debug.setAstronautPosition({ x, z, yawDegrees: 90, cameraYawDegrees: 90 });
      await api.renderFrames(30);
      api.injectInput({ keys: ['KeyW'], durationMs: ${Math.round((walkFrames / 60) * 1000)} });
      const samples = [];
      for (let frame = 0; frame < ${walkFrames}; frame++) {
        await api.renderFrames(1);
        const stats = api.stats();
        samples.push({
          origin: stats.origin.offset,
          shifts: stats.origin.shifts,
          astronaut: stats.astronaut.position,
          camera: stats.camera.position,
          feet: stats.feet.map((foot) => ({ inStance: foot.inStance, stanceSerial: foot.stanceSerial, plant: foot.plantPosition })),
        });
      }
      return { samples, pageErrors: api.stats().gpuErrors };
    })()`), { timeoutMs: 180000 });
  }
  const pageErrors = page.pageErrors();
  if (pageErrors.length) problems.push(`page errors: ${pageErrors.map((event) => event.text).join(' | ')}`);
} finally {
  await target.close();
}

const imageComparison = await withImageWorkbench([imagePaths.before, imagePaths.beforeRepeat, imagePaths.after], async ({ page, imageUrl, takeUpload }) => {
  const result = await page.evaluate(`(async () => {
    const load = async (url) => {
      const image = new Image();
      image.src = url;
      await image.decode();
      const canvas = new OffscreenCanvas(image.naturalWidth, image.naturalHeight);
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(image, 0, 0);
      return context.getImageData(0, 0, canvas.width, canvas.height);
    };
    const [before, beforeRepeat, after] = await Promise.all([load('${imageUrl(0)}'), load('${imageUrl(1)}'), load('${imageUrl(2)}')]);
    const width = before.width;
    const height = before.height;
    const tileEdge = ${tileEdgePixels};
    const tilesAcross = Math.ceil(width / tileEdge);
    const tilesDown = Math.ceil(height / tileEdge);
    const compare = (first, second, heat) => {
      const histogram = new Float64Array(256);
      const tileSums = new Float64Array(tilesAcross * tilesDown);
      const tileCounts = new Float64Array(tilesAcross * tilesDown);
      let sum = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const offset = (y * width + x) * 4;
          const difference = Math.max(Math.abs(first.data[offset] - second.data[offset]), Math.abs(first.data[offset + 1] - second.data[offset + 1]), Math.abs(first.data[offset + 2] - second.data[offset + 2]));
          histogram[difference]++;
          sum += difference;
          const tile = Math.floor(y / tileEdge) * tilesAcross + Math.floor(x / tileEdge);
          tileSums[tile] += difference;
          tileCounts[tile]++;
          if (heat) {
            const amplified = Math.min(255, difference * 8);
            heat.data[offset] = amplified;
            heat.data[offset + 1] = amplified;
            heat.data[offset + 2] = amplified;
            heat.data[offset + 3] = 255;
          }
        }
      }
      const pixelCount = width * height;
      const percentile = (fraction) => {
        let accumulated = 0;
        for (let value = 0; value < 256; value++) {
          accumulated += histogram[value];
          if (accumulated >= fraction * pixelCount) return value;
        }
        return 255;
      };
      let largestTileMean = 0;
      let largestTile = 0;
      for (let tile = 0; tile < tileSums.length; tile++) {
        const mean = tileSums[tile] / tileCounts[tile];
        if (mean > largestTileMean) {
          largestTileMean = mean;
          largestTile = tile;
        }
      }
      let fractionAboveSixteen = 0;
      for (let value = 17; value < 256; value++) fractionAboveSixteen += histogram[value];
      return {
        meanDifference: sum / pixelCount,
        p99: percentile(0.99),
        p999: percentile(0.999),
        fractionAboveSixteen: fractionAboveSixteen / pixelCount,
        largestTileMean,
        largestTileCentre: [((largestTile % tilesAcross) + 0.5) * tileEdge, (Math.floor(largestTile / tilesAcross) + 0.5) * tileEdge],
      };
    };
    const heatCanvas = new OffscreenCanvas(width, height);
    const heatContext = heatCanvas.getContext('2d');
    const heat = heatContext.createImageData(width, height);
    const baseline = compare(before, beforeRepeat, null);
    const shifted = compare(beforeRepeat, after, heat);
    heatContext.putImageData(heat, 0, 0);
    const blob = await heatCanvas.convertToBlob({ type: 'image/png' });
    await fetch('/upload/difference', { method: 'POST', body: blob });
    return { width, height, baseline, shifted };
  })()`, { timeoutMs: 180000 });
  writeFileSync(imagePaths.difference, takeUpload('difference'));
  return result;
});

const { baseline, shifted } = imageComparison;
const meanLimit = baseline.meanDifference * 1.25 + 0.2;
const tileLimit = baseline.largestTileMean * 1.5 + 2;
const highPercentileLimit = baseline.p999 + 2;
const brightFractionLimit = baseline.fractionAboveSixteen + 1e-4;
if (shifted.meanDifference > meanLimit) problems.push(`mean pixel difference across the shift ${shifted.meanDifference.toFixed(3)} > ${meanLimit.toFixed(3)} (1.25x the no-shift baseline ${baseline.meanDifference.toFixed(3)} + 0.2)`);
if (shifted.largestTileMean > tileLimit) problems.push(`worst ${tileEdgePixels}px tile differs by ${shifted.largestTileMean.toFixed(2)} on average at ${shifted.largestTileCentre} > ${tileLimit.toFixed(2)} (1.5x the baseline ${baseline.largestTileMean.toFixed(2)} + 2)`);
if (shifted.p999 > highPercentileLimit) problems.push(`99.9th percentile difference ${shifted.p999} > ${highPercentileLimit} (baseline ${baseline.p999} + 2)`);
if (shifted.fractionAboveSixteen > brightFractionLimit) problems.push(`${(shifted.fractionAboveSixteen * 100).toFixed(3)}% of pixels differ by more than 16 levels (baseline ${(baseline.fractionAboveSixteen * 100).toFixed(3)}% + 0.01%)`);
const expectedRenderX = astronautBeforeShift[0] - forcedShiftMetres;
if (Math.abs(staticView.afterShift.astronaut[0] - expectedRenderX) > 1e-6) problems.push(`after the forced shift the astronaut sits at render x ${staticView.afterShift.astronaut[0]} (expected ${expectedRenderX})`);
if (Math.abs(staticView.afterShift.absolute[0] - staticView.absolute[0]) > 1e-6 || Math.abs(staticView.afterShift.absolute[2] - staticView.absolute[2]) > 1e-6) problems.push('the astronaut absolute position changed across the forced shift');

let walkSummary = null;
if (walk) {
  const samples = walk.samples;
  let largestAstronautStep = 0;
  let largestCameraStep = 0;
  let largestHeightStep = 0;
  let largestPlantSlip = 0;
  let shiftFrame = -1;
  for (let index = 1; index < samples.length; index++) {
    const previous = samples[index - 1];
    const current = samples[index];
    if (current.shifts !== previous.shifts) shiftFrame = index;
    const absolute = (sample, position) => [position[0] + sample.origin[0], position[1], position[2] + sample.origin[2]];
    const astronautBefore = absolute(previous, previous.astronaut);
    const astronautNow = absolute(current, current.astronaut);
    largestAstronautStep = Math.max(largestAstronautStep, Math.hypot(astronautNow[0] - astronautBefore[0], astronautNow[2] - astronautBefore[2]));
    largestHeightStep = Math.max(largestHeightStep, Math.abs(astronautNow[1] - astronautBefore[1]));
    const cameraBefore = absolute(previous, previous.camera);
    const cameraNow = absolute(current, current.camera);
    largestCameraStep = Math.max(largestCameraStep, Math.hypot(cameraNow[0] - cameraBefore[0], cameraNow[1] - cameraBefore[1], cameraNow[2] - cameraBefore[2]));
    current.feet.forEach((foot, footIndex) => {
      const footBefore = previous.feet[footIndex];
      if (foot.inStance && footBefore.inStance && foot.stanceSerial === footBefore.stanceSerial) {
        const plantBefore = absolute(previous, footBefore.plant);
        const plantNow = absolute(current, foot.plant);
        largestPlantSlip = Math.max(largestPlantSlip, Math.hypot(plantNow[0] - plantBefore[0], plantNow[1] - plantBefore[1], plantNow[2] - plantBefore[2]));
      }
    });
  }
  const first = samples[0];
  const last = samples[samples.length - 1];
  walkSummary = {
    frames: samples.length,
    shiftFrame,
    shiftsBefore: first.shifts,
    shiftsAfter: last.shifts,
    originAfter: last.origin,
    startAbsoluteX: first.astronaut[0] + first.origin[0],
    endAbsoluteX: last.astronaut[0] + last.origin[0],
    endRenderX: last.astronaut[0],
    largestAstronautStepMetres: largestAstronautStep,
    largestHeightStepMetres: largestHeightStep,
    largestCameraStepMetres: largestCameraStep,
    largestPlantSlipMetres: largestPlantSlip,
  };
  if (last.shifts - first.shifts !== 1) problems.push(`the walk across x = 1000 m shifted the origin ${last.shifts - first.shifts} times (expected once)`);
  if (last.origin[0] - first.origin[0] !== 1024 || last.origin[2] !== first.origin[2]) problems.push(`the origin moved by ${last.origin[0] - first.origin[0]}, ${last.origin[2] - first.origin[2]} (expected 1024, 0)`);
  if (largestAstronautStep > 0.05) problems.push(`the astronaut jumped ${largestAstronautStep.toFixed(4)} m in one frame (absolute)`);
  if (largestHeightStep > 0.02) problems.push(`the astronaut height jumped ${largestHeightStep.toFixed(4)} m in one frame`);
  if (largestCameraStep > 0.1) problems.push(`the camera jumped ${largestCameraStep.toFixed(4)} m in one frame (absolute)`);
  if (largestPlantSlip > 1e-6) problems.push(`a planted foot slid ${largestPlantSlip.toExponential(2)} m (absolute) during one stance`);
  if (walkSummary.endAbsoluteX < 1003) problems.push(`the walk ended at absolute x ${walkSummary.endAbsoluteX.toFixed(2)} m, short of crossing well past 1000 m`);
}

const report = { forcedShiftMetres, plantedFault, staticView, imageComparison, walk: walkSummary, problems };
writeFileSync(path.join(evidenceDirectory(), `${filePrefix}-check.json`), JSON.stringify(report, null, 2));
console.log(`forced shift ${forcedShiftMetres} m${plantedFault ? ' (planted fault: not a multiple of the 10.24 m ripple period)' : ''}`);
console.log(`same view, no shift:   mean ${baseline.meanDifference.toFixed(3)}, p99 ${baseline.p99}, p99.9 ${baseline.p999}, >16: ${(baseline.fractionAboveSixteen * 100).toFixed(3)}%, worst tile ${baseline.largestTileMean.toFixed(2)}`);
console.log(`same view, with shift: mean ${shifted.meanDifference.toFixed(3)}, p99 ${shifted.p99}, p99.9 ${shifted.p999}, >16: ${(shifted.fractionAboveSixteen * 100).toFixed(3)}%, worst tile ${shifted.largestTileMean.toFixed(2)} at ${shifted.largestTileCentre}`);
if (walkSummary) console.log(`walk: absolute x ${walkSummary.startAbsoluteX.toFixed(2)} -> ${walkSummary.endAbsoluteX.toFixed(2)} m, shifted at frame ${walkSummary.shiftFrame}, origin now ${walkSummary.originAfter[0]}, render x ${walkSummary.endRenderX.toFixed(2)}; largest per-frame step: astronaut ${walkSummary.largestAstronautStepMetres.toFixed(4)} m, height ${walkSummary.largestHeightStepMetres.toFixed(4)} m, camera ${walkSummary.largestCameraStepMetres.toFixed(4)} m; planted-foot slip ${walkSummary.largestPlantSlipMetres.toExponential(2)} m`);
console.log(problems.length ? `FAIL\n  ${problems.join('\n  ')}` : 'PASS');
process.exit(problems.length ? 1 : 0);
