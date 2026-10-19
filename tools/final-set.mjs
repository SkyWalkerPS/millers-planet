import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { evidenceDirectory, projectRoot } from './target.mjs';
import { SHOTS } from './shots.mjs';
import { assertStillsStayInStills, withImageWorkbench } from './image-workbench.mjs';

const finalDirectory = path.join(projectRoot, 'evidence', 'final');
const outputWidth = 1728;
const outputHeight = 1117;
const jpegQuality = 0.9;
const productShotKinds = new Set(['still', 'freshLoad', 'afterReload', 'byTool']);
const shotsLeftOut = new Set(['taau-ghost']);

const builtAtMs = statSync(path.join(projectRoot, 'dist', 'index.html')).mtimeMs;
const chosen = [];
const missing = [];
const stale = [];
for (const shot of SHOTS) {
  if (shot.phase < 3 || !productShotKinds.has(shot.kind) || shotsLeftOut.has(shot.name)) continue;
  const candidates = readdirSync(evidenceDirectory()).filter((fileName) => fileName.match(/^\d+-(.+)\.png$/)?.[1] === shot.name);
  if (!candidates.length) {
    missing.push(shot.name);
    continue;
  }
  const source = candidates.map((fileName) => path.join(evidenceDirectory(), fileName)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  if (statSync(source).mtimeMs < builtAtMs) {
    stale.push(shot.name);
    continue;
  }
  chosen.push({ name: shot.name, source });
}
if (stale.length) {
  console.error(`Refusing to build the final set: ${stale.length} screenshot(s) are older than dist/index.html (${stale.join(', ')}). Re-shoot them from the production build first.`);
  process.exit(1);
}

mkdirSync(finalDirectory, { recursive: true });
for (const fileName of readdirSync(finalDirectory)) {
  if (fileName.endsWith('.jpg')) rmSync(path.join(finalDirectory, fileName));
}

const written = [];
await withImageWorkbench(chosen.map((entry) => entry.source), async ({ page, imageUrl, takeUpload }) => {
  for (let index = 0; index < chosen.length; index++) {
    const output = path.join(finalDirectory, `${chosen[index].name}.jpg`);
    assertStillsStayInStills([chosen[index].source], output);
    const size = await page.evaluate(`(async () => {
      const image = new Image();
      image.src = '${imageUrl(index)}';
      await image.decode();
      const canvas = new OffscreenCanvas(${outputWidth}, ${outputHeight});
      const context = canvas.getContext('2d');
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(image, 0, 0, ${outputWidth}, ${outputHeight});
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: ${jpegQuality} });
      await fetch('/upload/final', { method: 'POST', body: blob });
      return { sourceWidth: image.naturalWidth, sourceHeight: image.naturalHeight };
    })()`, { timeoutMs: 120000 });
    const bytes = takeUpload('final');
    writeFileSync(output, bytes);
    written.push({ name: chosen[index].name, bytes: bytes.length, ...size });
  }
});

const totalBytes = written.reduce((sum, entry) => sum + entry.bytes, 0);
for (const entry of written) console.log(`${entry.name}.jpg  ${(entry.bytes / 1024).toFixed(0)} kB  (from ${entry.sourceWidth}x${entry.sourceHeight})`);
console.log(`${written.length} JPEG(s) at ${outputWidth}x${outputHeight}, quality ${jpegQuality * 100}, ${(totalBytes / 1024 / 1024).toFixed(2)} MB in ${path.relative(projectRoot, finalDirectory)}/`);
if (missing.length) console.log(`No screenshot found for: ${missing.join(', ')}`);
