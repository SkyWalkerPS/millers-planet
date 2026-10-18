import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { SHOT_KINDS, applyShotSetup, selectShots } from './shots.mjs';
import { evidenceDirectory, openMillersPlanet, waitForMillersPlanetReady } from './target.mjs';
import { normaliseCropRectangle, pageExpression } from './page-results.mjs';
import { formatNumber } from './stats.mjs';

const FINAL_IMAGE_WIDTH = 1728;
const FINAL_JPEG_QUALITY = 90;
const settleFrameCount = Number(process.env.FRAMES || 32);
const writeFinalImages = process.env.FINAL === '1';
const scaleSetting = process.env.SCALE || '0.7';
const defaultPhase = Number(process.env.PHASE || 2);

let shots;
try {
  shots = selectShots(process.argv.slice(2), defaultPhase);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const outputDirectory = writeFinalImages ? path.join(evidenceDirectory(), 'final') : evidenceDirectory();
mkdirSync(outputDirectory, { recursive: true });
const failures = [];
const displayPath = (filePath) => {
  const relativePath = path.relative(process.cwd(), filePath);
  return relativePath.startsWith('..') ? filePath : relativePath;
};
const target = await openMillersPlanet({ query: scaleSetting === 'live' ? {} : { scale: scaleSetting } });

try {
  const { page, viewport } = target;
  const expectedWidth = Math.round(viewport.width * viewport.deviceScaleFactor);
  const expectedHeight = Math.round(viewport.height * viewport.deviceScaleFactor);
  console.log(`Shooting ${shots.length} shot(s) from ${target.server.description}`);
  console.log(`Window ${viewport.width}x${viewport.height} at ${viewport.deviceScaleFactor}x, render scale ${scaleSetting === 'live' ? 'live (controller)' : `pinned to ${scaleSetting}`}, ${settleFrameCount} settle frames per shot, writing to ${outputDirectory}\n`);
  const orderedShots = [...shots.filter((shot) => shot.kind === 'freshLoad'), ...shots.filter((shot) => shot.kind !== 'freshLoad')];
  let pageIsFresh = true;
  for (const shot of orderedShots) {
    try {
      if (shot.kind === 'framePair' || shot.kind === 'sequence') {
        throw new Error(`shot kind "${shot.kind}" (${SHOT_KINDS[shot.kind]}) is not supported by shoot.mjs yet`);
      }
      if (shot.kind === 'afterReload' || (shot.kind === 'freshLoad' && !pageIsFresh)) {
        await page.reload();
        await waitForMillersPlanetReady(page);
      }
      pageIsFresh = false;
      const shotResult = await applyShotSetup(page, shot);
      const frameResult = await page.evaluate(pageExpression(`window.millersPlanet.renderFrames(${shot.settleFrames ?? settleFrameCount})`));
      const pageState = await page.evaluate(pageExpression(`(() => {
        const stats = window.millersPlanet.stats();
        return { gpuErrors: stats.gpuErrors || [], cameraMode: stats.camera?.mode, wavePhase: stats.wave?.phase, shipState: stats.ship?.state };
      })()`));
      const spanMs = frameResult?.gpu?.spanMs ?? frameResult?.gpu?.totalMs;
      const internal = Array.isArray(frameResult?.internal) ? frameResult.internal.join('x') : '?';
      const writtenFiles = [];
      if (writeFinalImages) {
        const clipScale = FINAL_IMAGE_WIDTH / expectedWidth;
        const filePath = path.join(outputDirectory, `${shot.name}.jpg`);
        const image = await page.screenshot(filePath, { format: 'jpeg', quality: FINAL_JPEG_QUALITY, clip: { x: 0, y: 0, width: viewport.width, height: viewport.height, scale: clipScale } });
        const expectedFinalHeight = Math.round(expectedHeight * clipScale);
        if (image.width !== FINAL_IMAGE_WIDTH || image.height !== expectedFinalHeight) throw new Error(`the final JPEG is ${image.width}x${image.height}, expected ${FINAL_IMAGE_WIDTH}x${expectedFinalHeight}`);
        writtenFiles.push(`${displayPath(filePath)} (${image.width}x${image.height})`);
      } else {
        const filePath = path.join(outputDirectory, `${shot.phase}-${shot.name}.png`);
        const image = await page.screenshot(filePath);
        if (image.width !== expectedWidth || image.height !== expectedHeight) throw new Error(`the screenshot is ${image.width}x${image.height}, expected ${expectedWidth}x${expectedHeight}`);
        writtenFiles.push(`${displayPath(filePath)} (${image.width}x${image.height})`);
        const crops = shotResult?.crop && typeof shotResult.crop === 'object' ? shotResult.crop : {};
        for (const [cropName, cropValue] of Object.entries(crops)) {
          const rectangle = normaliseCropRectangle(cropValue);
          if (!rectangle) {
            console.warn(`  WARNING: ${shot.name} returned an unusable crop "${cropName}": ${JSON.stringify(cropValue)}`);
            continue;
          }
          const cropPath = path.join(outputDirectory, `${shot.phase}-${shot.name}-${cropName}.png`);
          const cropImage = await page.screenshot(cropPath, { clip: rectangle });
          writtenFiles.push(`${displayPath(cropPath)} (${cropImage.width}x${cropImage.height})`);
        }
        const missingCrops = (shot.expectedCrops || []).filter((cropName) => !(cropName in crops));
        if (missingCrops.length) console.warn(`  WARNING: ${shot.name} should return crop(s) ${missingCrops.join(', ')} from setCameraShot, but did not`);
      }
      const stateNotes = [pageState.cameraMode && `camera ${pageState.cameraMode}`, pageState.wavePhase && `wave ${pageState.wavePhase}`, pageState.shipState !== undefined && pageState.shipState !== null && `ship ${pageState.shipState}`].filter(Boolean).join(', ');
      console.log(`${shot.name}: GPU span ${formatNumber(spanMs)} ms, render scale ${formatNumber(frameResult?.renderScale, 3)}, internal ${internal}${stateNotes ? `, ${stateNotes}` : ''}`);
      for (const written of writtenFiles) console.log(`  wrote ${written}`);
      if (pageState.gpuErrors.length) throw new Error(`GPU errors after this shot: ${pageState.gpuErrors.map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry))).join(' | ')}`);
    } catch (error) {
      console.log(`${shot.name}: FAILED: ${error.message.split('\n')[0]}`);
      failures.push(`${shot.name}: ${error.message.split('\n')[0]}`);
    }
  }
  const pageErrors = page.pageErrors();
  if (pageErrors.length) {
    console.log('\nThe page reported errors:');
    for (const event of pageErrors) console.log(`  [${event.kind}] ${event.text}`);
    failures.push(`${pageErrors.length} page error(s)`);
  }
  const pageWarnings = page.pageWarnings();
  if (pageWarnings.length) {
    console.log('\nThe page reported warnings:');
    for (const event of pageWarnings.slice(0, 20)) console.log(`  [${event.kind}] ${event.text}`);
  }
} finally {
  await target.close();
}

if (failures.length) {
  console.log(`\nshoot FAILED (${failures.length} problem(s)):\n${failures.map((failure) => `  ${failure}`).join('\n')}`);
  process.exit(1);
}
console.log(`\nAll ${shots.length} shot(s) written. Look at every image before trusting it.`);
