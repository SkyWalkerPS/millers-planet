import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { IMAGE_EXTENSIONS, assertStillsStayInStills, isInsideReferenceStills, parseCommandLine, withImageWorkbench } from './image-workbench.mjs';
import { readImageDimensions } from './cdp.mjs';

const USAGE = `Usage:
  node tools/contact-sheet.mjs <folder or images...> <out.jpg|out.png> [--columns 3] [--tile-width 864] [--filter prefix]
  node tools/contact-sheet.mjs --pair <our image> <film still> <out.jpg> [--height 720]`;
const LABEL_BAND_HEIGHT = 30;
const GAP = 8;
const BACKGROUND_COLOUR = '#1d1d1d';
const JPEG_QUALITY = 0.85;

function outputTypeFor(outputPath) {
  const extension = path.extname(outputPath).toLowerCase();
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.png') return 'image/png';
  throw new Error(`The output must end in .jpg, .jpeg or .png (got ${outputPath})`);
}

function collectImages(inputs, prefixFilter) {
  const images = [];
  for (const input of inputs) {
    const inputPath = path.resolve(input);
    if (statSync(inputPath).isDirectory()) {
      const names = readdirSync(inputPath).filter((name) => IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase())).filter((name) => !prefixFilter || name.startsWith(prefixFilter)).sort();
      images.push(...names.map((name) => path.join(inputPath, name)));
    } else {
      images.push(inputPath);
    }
  }
  return images;
}

const DECODE_TILE_FUNCTION = `async (imageUrl, slot, maximumWidth, fixedHeight) => {
  const blob = await (await fetch(imageUrl)).blob();
  const fullImage = await createImageBitmap(blob);
  const naturalWidth = fullImage.width;
  const naturalHeight = fullImage.height;
  const tileWidth = fixedHeight ? Math.round(fixedHeight * naturalWidth / naturalHeight) : maximumWidth;
  const tileHeight = fixedHeight ? fixedHeight : Math.round(maximumWidth * naturalHeight / naturalWidth);
  const tileCanvas = new OffscreenCanvas(tileWidth, tileHeight);
  const tileContext = tileCanvas.getContext('2d');
  tileContext.imageSmoothingEnabled = true;
  tileContext.imageSmoothingQuality = 'high';
  tileContext.drawImage(fullImage, 0, 0, tileWidth, tileHeight);
  fullImage.close();
  window.sheetTiles = window.sheetTiles || [];
  window.sheetTiles[slot] = tileCanvas.transferToImageBitmap();
  return { naturalWidth, naturalHeight, tileWidth, tileHeight };
}`;

const COMPOSE_SHEET_FUNCTION = `async (layout, outputType, quality) => {
  const canvas = new OffscreenCanvas(layout.width, layout.height);
  const context = canvas.getContext('2d');
  context.fillStyle = layout.background;
  context.fillRect(0, 0, layout.width, layout.height);
  for (const placement of layout.placements) {
    context.drawImage(window.sheetTiles[placement.slot], placement.x, placement.y);
    context.fillStyle = 'rgba(0, 0, 0, 0.72)';
    context.fillRect(placement.x, placement.y + placement.height, placement.width, layout.labelBandHeight);
    context.fillStyle = '#f2f2f2';
    context.font = '17px -apple-system, system-ui, sans-serif';
    context.textBaseline = 'middle';
    context.fillText(placement.label, placement.x + 8, placement.y + placement.height + layout.labelBandHeight / 2, placement.width - 16);
  }
  const blob = await canvas.convertToBlob(outputType === 'image/jpeg' ? { type: outputType, quality } : { type: outputType });
  const response = await fetch('/upload/sheet', { method: 'POST', body: blob });
  return response.ok;
}`;

async function buildSheet(imagePaths, outputPath, { columns, tileWidth, pairHeight, labels }) {
  const outputType = outputTypeFor(outputPath);
  await withImageWorkbench(imagePaths, async ({ page, imageUrl, takeUpload }) => {
    const tiles = [];
    for (let slot = 0; slot < imagePaths.length; slot++) {
      tiles.push(await page.evaluateFunction(DECODE_TILE_FUNCTION, [imageUrl(slot), slot, tileWidth, pairHeight || 0], { timeoutMs: 60000 }));
    }
    const placements = [];
    let cursorY = GAP;
    let sheetWidth = 0;
    for (let rowStart = 0; rowStart < tiles.length; rowStart += columns) {
      const rowTiles = tiles.slice(rowStart, rowStart + columns);
      let cursorX = GAP;
      for (const [offset, tile] of rowTiles.entries()) {
        placements.push({ slot: rowStart + offset, x: cursorX, y: cursorY, width: tile.tileWidth, height: tile.tileHeight, label: labels[rowStart + offset] });
        cursorX += tile.tileWidth + GAP;
      }
      sheetWidth = Math.max(sheetWidth, cursorX);
      cursorY += Math.max(...rowTiles.map((tile) => tile.tileHeight)) + LABEL_BAND_HEIGHT + GAP;
    }
    const layout = { width: sheetWidth, height: cursorY, background: BACKGROUND_COLOUR, labelBandHeight: LABEL_BAND_HEIGHT, placements };
    const uploaded = await page.evaluateFunction(COMPOSE_SHEET_FUNCTION, [layout, outputType, JPEG_QUALITY], { timeoutMs: 120000 });
    const bytes = takeUpload('sheet');
    if (!uploaded || !bytes) throw new Error('the browser did not hand back the finished sheet');
    mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
    writeFileSync(outputPath, bytes);
    const { width, height } = readImageDimensions(bytes);
    console.log(`Wrote ${outputPath} (${width}x${height}, ${imagePaths.length} image(s), ${(bytes.length / 1024).toFixed(0)} KB)`);
    tiles.forEach((tile, slot) => console.log(`  ${labels[slot]}: ${tile.naturalWidth}x${tile.naturalHeight} shown at ${tile.tileWidth}x${tile.tileHeight}`));
  });
}

let parsed;
try {
  parsed = parseCommandLine(process.argv.slice(2), { valueFlags: ['columns', 'tile-width', 'filter', 'height'], booleanFlags: ['pair', 'help'] });
} catch (error) {
  console.error(`${error.message}\n${USAGE}`);
  process.exit(1);
}
const { positionals, flags } = parsed;
if (flags.help || positionals.length < 2) {
  console.log(USAGE);
  process.exit(flags.help ? 0 : 1);
}

try {
  if (flags.pair) {
    if (positionals.length !== 3) throw new Error(`--pair needs exactly three paths: <our image> <film still> <out>\n${USAGE}`);
    const [oursPath, stillPath, outputPath] = positionals.map((value) => path.resolve(value));
    assertStillsStayInStills([oursPath, stillPath], outputPath);
    const pairHeight = Number(flags.height?.[0] || 720);
    const labelFor = (imagePath) => `${isInsideReferenceStills(imagePath) ? 'film still' : 'ours'}: ${path.basename(imagePath)}`;
    await buildSheet([oursPath, stillPath], outputPath, { columns: 2, tileWidth: 0, pairHeight, labels: [labelFor(oursPath), labelFor(stillPath)] });
  } else {
    const outputPath = path.resolve(positionals[positionals.length - 1]);
    const imagePaths = collectImages(positionals.slice(0, -1), flags.filter?.[0]).filter((imagePath) => imagePath !== outputPath);
    if (!imagePaths.length) throw new Error('No images found for the sheet');
    assertStillsStayInStills(imagePaths, outputPath);
    const columns = Number(flags.columns?.[0] || 3);
    const tileWidth = Number(flags['tile-width']?.[0] || 864);
    await buildSheet(imagePaths, outputPath, { columns, tileWidth, labels: imagePaths.map((imagePath) => path.basename(imagePath, path.extname(imagePath))) });
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
