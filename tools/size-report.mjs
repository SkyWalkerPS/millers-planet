import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib';
import { formatTable } from './stats.mjs';
import { findSourcesNewerThanBuild } from './target.mjs';

export const BROTLI_BUDGET_BYTES = Number(process.env.BUDGET_BYTES || 1500000);
const BIGGEST_COUNT = 15;
const BASE64_DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_VALUE_BY_DIGIT = Object.fromEntries([...BASE64_DIGITS].map((digit, value) => [digit, value]));

function listFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

export function measureFile(filePath) {
  const bytes = readFileSync(filePath);
  return {
    rawBytes: bytes.length,
    gzipBytes: gzipSync(bytes, { level: 9 }).length,
    brotliBytes: brotliCompressSync(bytes, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11, [zlibConstants.BROTLI_PARAM_SIZE_HINT]: bytes.length } }).length,
  };
}

export function decodeVlqSegment(segment) {
  const values = [];
  let value = 0;
  let shift = 0;
  for (const digit of segment) {
    const digitValue = BASE64_VALUE_BY_DIGIT[digit];
    if (digitValue === undefined) throw new Error(`Bad source-map digit "${digit}"`);
    value += (digitValue & 31) << shift;
    if (digitValue & 32) {
      shift += 5;
    } else {
      values.push(value & 1 ? -(value >>> 1) : value >>> 1);
      value = 0;
      shift = 0;
    }
  }
  return values;
}

export function attributeGeneratedBytes(sourceMap, generatedCode) {
  const generatedLines = generatedCode.split('\n');
  const bytesBySource = new Map();
  let sourceIndex = 0;
  sourceMap.mappings.split(';').forEach((lineMappings, lineIndex) => {
    const lineLength = Buffer.byteLength(generatedLines[lineIndex] ?? '');
    let generatedColumn = 0;
    const segments = [];
    for (const segmentText of lineMappings.split(',')) {
      if (!segmentText) continue;
      const fields = decodeVlqSegment(segmentText);
      generatedColumn += fields[0];
      if (fields.length >= 4) {
        sourceIndex += fields[1];
        segments.push({ column: generatedColumn, sourceIndex });
      } else {
        segments.push({ column: generatedColumn, sourceIndex: null });
      }
    }
    segments.forEach((segment, position) => {
      if (segment.sourceIndex === null) return;
      const end = position + 1 < segments.length ? segments[position + 1].column : lineLength;
      const source = sourceMap.sources[segment.sourceIndex] ?? `source ${segment.sourceIndex}`;
      bytesBySource.set(source, (bytesBySource.get(source) || 0) + Math.max(0, end - segment.column));
    });
  });
  return bytesBySource;
}

function packageOf(sourcePath) {
  const match = sourcePath.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/);
  if (match) return match[1];
  if (sourcePath.includes('/src/') || sourcePath.startsWith('src/') || sourcePath.startsWith('../src/')) return 'src (our code)';
  return 'other';
}

const formatKilobytes = (bytes) => `${(bytes / 1000).toFixed(1)} kB`;

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const distDirectory = path.resolve(process.argv[2] || path.join(projectRoot, 'dist'));
  if (!existsSync(distDirectory) || !statSync(distDirectory).isDirectory()) {
    console.error(`${distDirectory} does not exist. Run "npm run build" first.`);
    process.exit(1);
  }
  const staleSources = process.argv[2] ? [] : findSourcesNewerThanBuild(projectRoot);
  if (staleSources.length) {
    console.error(`dist/ is older than ${staleSources.length} source file(s) (${staleSources.slice(0, 5).join(', ')}${staleSources.length > 5 ? ', ...' : ''}), so its size would be out of date. Run "npm run build" first.`);
    process.exit(1);
  }
  const allFiles = listFiles(distDirectory);
  const mapFiles = allFiles.filter((filePath) => filePath.endsWith('.map'));
  const onDemandVideos = allFiles.filter((filePath) => filePath.endsWith('.mp4'));
  const shippedFiles = allFiles.filter((filePath) => !filePath.endsWith('.map') && !filePath.endsWith('.mp4'));
  if (onDemandVideos.length) console.log(`Videos served on request, not part of the page and not counted: ${onDemandVideos.map((filePath) => `${path.relative(distDirectory, filePath)} ${formatKilobytes(statSync(filePath).size)}`).join(', ')}`);
  const measured = shippedFiles.map((filePath) => ({ name: path.relative(distDirectory, filePath), ...measureFile(filePath) }));
  const totals = measured.reduce((sum, entry) => ({ rawBytes: sum.rawBytes + entry.rawBytes, gzipBytes: sum.gzipBytes + entry.gzipBytes, brotliBytes: sum.brotliBytes + entry.brotliBytes }), { rawBytes: 0, gzipBytes: 0, brotliBytes: 0 });
  const biggest = [...measured].sort((first, second) => second.brotliBytes - first.brotliBytes).slice(0, BIGGEST_COUNT);
  console.log(`Download size of ${distDirectory} (${shippedFiles.length} file(s), source maps excluded)\n`);
  console.log(formatTable(['file', 'raw', 'gzip -9', 'brotli q11'], biggest.map((entry) => [entry.name, formatKilobytes(entry.rawBytes), formatKilobytes(entry.gzipBytes), formatKilobytes(entry.brotliBytes)]), { rightAlignFrom: 1 }));
  if (measured.length > BIGGEST_COUNT) console.log(`(${measured.length - BIGGEST_COUNT} smaller file(s) not listed)`);
  console.log(`\ntotal: raw ${formatKilobytes(totals.rawBytes)}, gzip ${formatKilobytes(totals.gzipBytes)}, brotli ${formatKilobytes(totals.brotliBytes)} (budget ${formatKilobytes(BROTLI_BUDGET_BYTES)} brotli)`);
  const otherFileTypes = shippedFiles.filter((filePath) => !/\.(html|js|css)$/.test(filePath)).map((filePath) => path.relative(distDirectory, filePath));
  if (otherFileTypes.length) console.log(`note: dist/ holds files other than HTML, JS and CSS: ${otherFileTypes.join(', ')}`);
  if (mapFiles.length) {
    console.log(`\nSource maps (not counted, but Vercel would serve them): ${mapFiles.map((filePath) => `${path.relative(distDirectory, filePath)} ${formatKilobytes(statSync(filePath).size)}`).join(', ')}`);
    const bytesBySource = new Map();
    for (const mapPath of mapFiles) {
      try {
        const sourceMap = JSON.parse(readFileSync(mapPath, 'utf8'));
        const generatedPath = mapPath.slice(0, -'.map'.length);
        if (!existsSync(generatedPath) || !sourceMap.mappings) continue;
        for (const [source, bytes] of attributeGeneratedBytes(sourceMap, readFileSync(generatedPath, 'utf8'))) bytesBySource.set(source, (bytesBySource.get(source) || 0) + bytes);
      } catch (error) {
        console.log(`  could not read ${path.basename(mapPath)}: ${error.message}`);
      }
    }
    if (bytesBySource.size) {
      const byPackage = new Map();
      for (const [source, bytes] of bytesBySource) byPackage.set(packageOf(source), (byPackage.get(packageOf(source)) || 0) + bytes);
      console.log('\nBiggest source modules (minified bytes in the built JS, before compression):');
      console.log(formatTable(['module', 'bytes'], [...bytesBySource].sort((first, second) => second[1] - first[1]).slice(0, BIGGEST_COUNT).map(([source, bytes]) => [source.replace(/^(\.\.\/)+/, ''), formatKilobytes(bytes)]), { rightAlignFrom: 1 }));
      console.log(`by package: ${[...byPackage].sort((first, second) => second[1] - first[1]).map(([name, bytes]) => `${name} ${formatKilobytes(bytes)}`).join(', ')}`);
    }
  } else if (totals.brotliBytes > BROTLI_BUDGET_BYTES) {
    console.log('\nTo see which modules are biggest, build once with source maps (vite build --sourcemap) and run this again.');
  }
  const overBudget = totals.brotliBytes > BROTLI_BUDGET_BYTES;
  console.log(overBudget ? `\nOVER BUDGET by ${formatKilobytes(totals.brotliBytes - BROTLI_BUDGET_BYTES)} brotli.` : `\nWithin budget: ${formatKilobytes(BROTLI_BUDGET_BYTES - totals.brotliBytes)} brotli to spare.`);
  process.exit(overBudget ? 1 : 0);
}
