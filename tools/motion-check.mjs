import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { evidenceDirectory, openMillersPlanet } from './target.mjs';
import { pageExpression } from './page-results.mjs';

const phase = Number(process.env.PHASE || 4);
const panFromYawDegrees = Number(process.env.PAN_FROM_YAW || -40);
const panToYawDegrees = Number(process.env.PAN_TO_YAW || 40);
const panSeconds = Number(process.env.PAN_SECONDS || 1);
const orbit = { pitchDegrees: 3, distance: 3.2, targetHeight: 1.45 };
const problems = [];
mkdirSync(evidenceDirectory(), { recursive: true });
const fileFor = (suffix) => path.join(evidenceDirectory(), `${phase}-taau-ghost-${suffix}.png`);

const target = await openMillersPlanet({ query: { scale: '0.7' } });
const report = { panFromYawDegrees, panToYawDegrees, panSeconds, frames: [] };
try {
  const { page } = target;
  const run = (body) => page.evaluate(pageExpression(`(async () => { const api = window.millersPlanet; ${body} })()`), { timeoutMs: 120000 });
  const middleYawDegrees = (panFromYawDegrees + panToYawDegrees) / 2;
  await run(`api.setCameraShot('sea-wide'); api.freezeTime(null); api.debug.setLiveLoopPaused(true);
    api.debug.setOrbitCamera(${JSON.stringify({ ...orbit, yawDegrees: middleYawDegrees, transitionSeconds: 0 })});
    await api.renderFrames(90); return true;`);
  const staticFrame = await run(`return { yawDegrees: api.stats().camera.yawDegrees, gpuErrors: api.stats().gpuErrors };`);
  await page.screenshot(fileFor('static'));
  report.frames.push({ file: path.basename(fileFor('static')), ...staticFrame });
  await run(`api.debug.setOrbitCamera(${JSON.stringify({ ...orbit, yawDegrees: panFromYawDegrees, transitionSeconds: 0 })});
    await api.renderFrames(30);
    api.debug.setOrbitCamera(${JSON.stringify({ ...orbit, yawDegrees: panToYawDegrees, transitionSeconds: panSeconds })});
    await api.renderFrames(${Math.round(panSeconds * 30) - 1}); return true;`);
  for (const suffix of ['pan', 'pan-next']) {
    const frame = await run(`await api.renderFrames(1); return { yawDegrees: api.stats().camera.yawDegrees, gpuErrors: api.stats().gpuErrors };`);
    await page.screenshot(fileFor(suffix));
    report.frames.push({ file: path.basename(fileFor(suffix)), ...frame });
  }
  await run(`api.debug.setLiveLoopPaused(false); return true;`);
  const [, panFrame, nextFrame] = report.frames;
  report.panDegreesPerFrame = Math.abs(nextFrame.yawDegrees - panFrame.yawDegrees);
  if (report.panDegreesPerFrame < 0.5) problems.push(`the camera moved only ${report.panDegreesPerFrame.toFixed(2)} degrees between the pan frames, so the check did not test fast motion`);
  for (const frame of report.frames) if (frame.gpuErrors.length) problems.push(`${frame.file}: GPU errors ${frame.gpuErrors.join(' | ')}`);
  const pageErrors = page.pageErrors();
  if (pageErrors.length) problems.push(`page errors: ${pageErrors.map((event) => event.text).join(' | ')}`);
} finally {
  await target.close();
}
writeFileSync(path.join(evidenceDirectory(), `${phase}-taau-ghost.json`), JSON.stringify({ ...report, problems }, null, 2));
console.log(`static frame at yaw ${report.frames[0]?.yawDegrees.toFixed(2)} degrees; pan frames at ${report.frames.slice(1).map((frame) => frame.yawDegrees.toFixed(2)).join(' and ')} degrees (${report.panDegreesPerFrame?.toFixed(2)} degrees per frame)`);
console.log('Look at the pan frames next to the static one: edges, the glitter path and the disk must not trail or double.');
console.log(problems.length ? `FAIL\n  ${problems.join('\n  ')}` : 'PASS (the images still need a look)');
process.exit(problems.length ? 1 : 0);
