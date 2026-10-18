import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertStillsStayInStills, parseCommandLine, withImageWorkbench } from './image-workbench.mjs';
import { formatNumber, formatTable } from './stats.mjs';

const USAGE = `Usage:
  node tools/measure-image.mjs <image> [--region name=x,y,w,h ...] [--contrast nameA,nameB ...] [--css-width 1728] [--json] [--out file.json]
Regions: four numbers all between 0 and 1 are fractions of the image; other numbers are CSS pixels of a
--css-width wide window (default 1728, so a 3456 px wide screenshot counts 2 image pixels per CSS pixel).
Prefix with px: for raw image pixels, css: or frac: to force the unit. With no --region the whole image is measured.`;

export function parseRegion(text) {
  const match = text.match(/^([\w-]+)=(?:(px|css|frac):)?([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)$/);
  if (!match) throw new Error(`Cannot read region "${text}" (expected name=x,y,w,h)`);
  const values = match.slice(3, 7).map(Number);
  const unit = match[2] || (values.every((value) => value >= 0 && value <= 1) ? 'frac' : 'css');
  return { name: match[1], unit, values };
}

export function regionToPixels(region, imageWidth, imageHeight, cssWidth) {
  const [x, y, width, height] = region.values;
  const factorX = region.unit === 'frac' ? imageWidth : region.unit === 'css' ? imageWidth / cssWidth : 1;
  const factorY = region.unit === 'frac' ? imageHeight : region.unit === 'css' ? imageWidth / cssWidth : 1;
  const left = Math.max(0, Math.round(x * factorX));
  const top = Math.max(0, Math.round(y * factorY));
  const right = Math.min(imageWidth, Math.round((x + width) * factorX));
  const bottom = Math.min(imageHeight, Math.round((y + height) * factorY));
  if (right <= left || bottom <= top) throw new Error(`Region "${region.name}" is empty or outside the ${imageWidth}x${imageHeight} image`);
  return { left, top, width: right - left, height: bottom - top };
}

export function colourStatistics(meanEncoded, meanLinear) {
  const [red, green, blue] = meanEncoded;
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const chroma = maximum - minimum;
  let hueDegrees = NaN;
  if (chroma > 1e-9) {
    if (maximum === red) hueDegrees = 60 * (((green - blue) / chroma) % 6);
    else if (maximum === green) hueDegrees = 60 * ((blue - red) / chroma + 2);
    else hueDegrees = 60 * ((red - green) / chroma + 4);
    if (hueDegrees < 0) hueDegrees += 360;
  }
  return {
    luminanceLinear: 0.2126 * meanLinear[0] + 0.7152 * meanLinear[1] + 0.0722 * meanLinear[2],
    lumaEncoded: 0.2126 * red + 0.7152 * green + 0.0722 * blue,
    hueDegrees,
    saturation: maximum > 0 ? chroma / maximum : 0,
    blueGreenOverRed: meanLinear[0] > 0 ? (meanLinear[1] + meanLinear[2]) / 2 / meanLinear[0] : Infinity,
  };
}

const LOAD_IMAGE_FUNCTION = `async (imageUrl) => {
  const image = new Image();
  image.src = imageUrl;
  await image.decode();
  const canvas = new OffscreenCanvas(image.naturalWidth, image.naturalHeight);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(image, 0, 0);
  window.measuredImage = { context, width: image.naturalWidth, height: image.naturalHeight };
  return { width: canvas.width, height: canvas.height };
}`;

const MEASURE_REGION_FUNCTION = `(left, top, width, height) => {
  const { data } = window.measuredImage.context.getImageData(left, top, width, height);
  const linearFromEncoded = new Float64Array(256);
  for (let level = 0; level < 256; level++) {
    const encoded = level / 255;
    linearFromEncoded[level] = encoded <= 0.04045 ? encoded / 12.92 : Math.pow((encoded + 0.055) / 1.055, 2.4);
  }
  const encodedSums = [0, 0, 0];
  const linearSums = [0, 0, 0];
  const pixelCount = width * height;
  for (let offset = 0; offset < data.length; offset += 4) {
    for (let channel = 0; channel < 3; channel++) {
      encodedSums[channel] += data[offset + channel];
      linearSums[channel] += linearFromEncoded[data[offset + channel]];
    }
  }
  return {
    pixelCount,
    meanEncoded: encodedSums.map((sum) => sum / pixelCount / 255),
    meanLinear: linearSums.map((sum) => sum / pixelCount),
  };
}`;

export async function measureImageRegions(imagePath, regions, cssWidth = 1728) {
  return withImageWorkbench([imagePath], async ({ page, imageUrl }) => {
    const size = await page.evaluateFunction(LOAD_IMAGE_FUNCTION, [imageUrl(0)], { timeoutMs: 60000 });
    const measured = [];
    for (const region of regions) {
      const pixels = regionToPixels(region, size.width, size.height, cssWidth);
      const sums = await page.evaluateFunction(MEASURE_REGION_FUNCTION, [pixels.left, pixels.top, pixels.width, pixels.height], { timeoutMs: 60000 });
      measured.push({ name: region.name, pixels, ...sums, ...colourStatistics(sums.meanEncoded, sums.meanLinear) });
    }
    return { size, measured };
  });
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  let parsed;
  try {
    parsed = parseCommandLine(process.argv.slice(2), { valueFlags: ['region', 'contrast', 'css-width', 'out'], booleanFlags: ['json', 'help'] });
  } catch (error) {
    console.error(`${error.message}\n${USAGE}`);
    process.exit(1);
  }
  const { positionals, flags } = parsed;
  if (flags.help || positionals.length !== 1) {
    console.log(USAGE);
    process.exit(flags.help ? 0 : 1);
  }
  try {
    const imagePath = path.resolve(positionals[0]);
    const outputPath = flags.out ? path.resolve(flags.out[0]) : null;
    if (outputPath) assertStillsStayInStills([imagePath], outputPath);
    const regions = (flags.region || ['whole=frac:0,0,1,1']).map(parseRegion);
    const cssWidth = Number(flags['css-width']?.[0] || 1728);
    const contrastPairs = (flags.contrast || []).map((text) => {
      const names = text.split(',');
      if (names.length !== 2 || !names.every((name) => regions.some((region) => region.name === name))) throw new Error(`--contrast ${text} must name two regions given with --region`);
      return names;
    });
    const { size, measured } = await measureImageRegions(imagePath, regions, cssWidth);
    const contrasts = contrastPairs.map(([first, second]) => {
      const a = measured.find((entry) => entry.name === first);
      const b = measured.find((entry) => entry.name === second);
      return { regions: [first, second], contrastLinear: (a.luminanceLinear - b.luminanceLinear) / b.luminanceLinear, contrastEncoded: (a.lumaEncoded - b.lumaEncoded) / b.lumaEncoded };
    });
    const report = { image: imagePath, size, cssWidth, regions: measured, contrasts };
    if (flags.json) {
      console.log(JSON.stringify(report, null, 1));
    } else {
      console.log(`${report.image} (${report.size.width}x${report.size.height})`);
      console.log(formatTable(
        ['region', 'pixels (x,y,w,h)', 'mean sRGB', 'mean linear RGB', 'Y linear', "Y' sRGB", 'hue', 'sat', '(G+B)/2/R'],
        report.regions.map((entry) => [
          entry.name,
          `${entry.pixels.left},${entry.pixels.top},${entry.pixels.width},${entry.pixels.height}`,
          entry.meanEncoded.map((value) => value.toFixed(3)).join(' '),
          entry.meanLinear.map((value) => value.toFixed(4)).join(' '),
          formatNumber(entry.luminanceLinear, 4),
          formatNumber(entry.lumaEncoded, 3),
          formatNumber(entry.hueDegrees, 1),
          formatNumber(entry.saturation, 3),
          formatNumber(entry.blueGreenOverRed, 3),
        ]),
        { rightAlignFrom: 2 },
      ));
      for (const contrast of report.contrasts) console.log(`contrast ${contrast.regions[0]} vs ${contrast.regions[1]}: ${(contrast.contrastLinear * 100).toFixed(1)}% (linear luminance), ${(contrast.contrastEncoded * 100).toFixed(1)}% (sRGB luma)`);
    }
    if (outputPath) {
      mkdirSync(path.dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, JSON.stringify(report, null, 1));
      console.log(`Wrote ${outputPath}`);
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
