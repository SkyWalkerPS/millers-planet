import { createServer } from 'node:http';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { launchChrome } from './cdp.mjs';
import { contentTypeFor } from './serve.mjs';
import { projectRoot } from './target.mjs';

export const REFERENCE_STILLS_DIRECTORY = path.join(projectRoot, 'reference-stills');
export const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

function resolveRealPath(filePath) {
  const absolutePath = path.resolve(filePath);
  if (existsSync(absolutePath)) return realpathSync(absolutePath);
  const missingParts = [];
  let existingDirectory = absolutePath;
  while (!existsSync(existingDirectory)) {
    missingParts.unshift(path.basename(existingDirectory));
    const parent = path.dirname(existingDirectory);
    if (parent === existingDirectory) break;
    existingDirectory = parent;
  }
  return path.join(realpathSync(existingDirectory), ...missingParts);
}

export function isInsideReferenceStills(filePath) {
  const stillsRoot = resolveRealPath(REFERENCE_STILLS_DIRECTORY);
  const resolved = resolveRealPath(filePath);
  return resolved === stillsRoot || resolved.startsWith(stillsRoot + path.sep);
}

export function assertStillsStayInStills(inputPaths, outputPath) {
  const stillInputs = inputPaths.filter(isInsideReferenceStills);
  if (stillInputs.length && !isInsideReferenceStills(outputPath)) {
    throw new Error(`Refusing to write ${outputPath}: it would include film stills (${stillInputs.map((stillPath) => path.basename(stillPath)).join(', ')}). Anything made from reference-stills/ must be written inside reference-stills/, never into evidence/, tools/ or dist/.`);
  }
}

export async function withImageWorkbench(imagePaths, callback) {
  const uploads = new Map();
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Image workbench</title><link rel="icon" href="data:,"></head><body></body></html>');
      return;
    }
    const imageMatch = url.pathname.match(/^\/image\/(\d+)$/);
    if (request.method === 'GET' && imageMatch && imagePaths[Number(imageMatch[1])]) {
      const imagePath = imagePaths[Number(imageMatch[1])];
      const bytes = readFileSync(imagePath);
      response.writeHead(200, { 'Content-Type': contentTypeFor(imagePath), 'Content-Length': bytes.length, 'Cache-Control': 'no-store' });
      response.end(bytes);
      return;
    }
    const uploadMatch = url.pathname.match(/^\/upload\/([\w-]+)$/);
    if (request.method === 'POST' && uploadMatch) {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        uploads.set(uploadMatch[1], Buffer.concat(chunks));
        response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('stored');
      });
      return;
    }
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('not found');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}/`;
  const browser = await launchChrome();
  try {
    const page = await browser.newPage();
    await page.goto(baseUrl);
    return await callback({ page, imageUrl: (index) => `/image/${index}`, takeUpload: (name) => uploads.get(name) });
  } finally {
    await browser.shutdown();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

export function parseCommandLine(argumentList, { valueFlags = [], booleanFlags = [] } = {}) {
  const positionals = [];
  const flags = {};
  for (let index = 0; index < argumentList.length; index++) {
    const argument = argumentList[index];
    if (argument.startsWith('--')) {
      const name = argument.slice(2);
      if (booleanFlags.includes(name)) {
        flags[name] = true;
      } else if (valueFlags.includes(name)) {
        if (index + 1 >= argumentList.length) throw new Error(`${argument} needs a value`);
        (flags[name] ||= []).push(argumentList[++index]);
      } else {
        throw new Error(`Unknown option ${argument}`);
      }
    } else {
      positionals.push(argument);
    }
  }
  return { positionals, flags };
}
