import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { sleep } from './cdp.mjs';
import { checkTimestampProbe, runTimestampProbe } from './preflight.mjs';
import { startStaticServer } from './serve.mjs';
import { evidenceDirectory, openMillersPlanet, projectRoot } from './target.mjs';
import { pageExpression } from './page-results.mjs';
import { formatTable } from './stats.mjs';

const PAGE_SPIKE_ITEMS = ['S0', 'S0b', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10', 'S11', 'S12', 'S13'];
const PHASE_THAT_OWNS_DEFERRED_ITEM = { S7: 4, S8: 3, S9: 3 };
const spikePhase = Number(process.env.PHASE || 2);
const renderSecondsForS14 = Number(process.env.S14_SECONDS || 10);
const distDirectory = path.resolve(process.env.SPIKE_DIST_DIRECTORY || path.join(projectRoot, 'dist'));
const rows = [];
let pageConsoleDuringRunAll = [];

function addRow(name, pass, details, fallbackUsed = null) {
  rows.push({ name, pass: Boolean(pass), details: String(details ?? ''), fallbackUsed: fallbackUsed || null });
}

function addDeferredRow(name, details) {
  rows.push({ name, pass: true, deferred: true, details: String(details), fallbackUsed: null });
}

function runCommand(command, commandArguments, { cwd }) {
  return new Promise((resolve) => {
    const child = spawn(command, commandArguments, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.on('error', (error) => resolve({ exitCode: -1, output: `${output}\n${error.message}` }));
    child.on('close', (exitCode) => resolve({ exitCode, output }));
  });
}

export function findStaticallyLoadedAssets(directory) {
  const indexPath = path.join(directory, 'index.html');
  const html = readFileSync(indexPath, 'utf8');
  const referenced = new Set();
  const pending = [];
  const addAsset = (reference, fromPathname) => {
    if (!reference || /^(data:|https?:|\/\/)/.test(reference)) return;
    const pathname = new URL(reference, `http://local${fromPathname}`).pathname;
    if (referenced.has(pathname)) return;
    referenced.add(pathname);
    if (pathname.endsWith('.js') || pathname.endsWith('.mjs')) pending.push(pathname);
  };
  for (const match of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) addAsset(match[1], '/index.html');
  for (const match of html.matchAll(/<link\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    if (/rel\s*=\s*["']?(stylesheet|modulepreload)/i.test(match[0])) addAsset(match[1], '/index.html');
  }
  while (pending.length) {
    const pathname = pending.pop();
    const filePath = path.join(directory, pathname);
    if (!existsSync(filePath)) continue;
    const source = readFileSync(filePath, 'utf8');
    for (const match of source.matchAll(/\b(?:from|import)\s*["']([^"']+\.m?js)["']/g)) addAsset(match[1], pathname);
  }
  return referenced;
}

export function classifyRequests(requests, baseUrl, staticAssets) {
  const origin = new URL(baseUrl).origin;
  const allowed = [];
  const problems = [];
  for (const request of requests) {
    const description = `${request.url.length > 120 ? `${request.url.slice(0, 117)}...` : request.url}${request.status ? ` (${request.status})` : ''}${request.failed ? ` (failed: ${request.failed})` : ''}`;
    if (request.url.startsWith('data:')) { allowed.push({ kind: 'data URL', description }); continue; }
    if (request.url.startsWith('blob:')) { allowed.push({ kind: 'blob made by the page', description }); continue; }
    let url;
    try {
      url = new URL(request.url);
    } catch {
      problems.push(`unreadable request URL ${description}`);
      continue;
    }
    if (url.origin !== origin) { problems.push(`request to another site: ${description}`); continue; }
    if (request.failed || (request.status && request.status >= 400)) { problems.push(`failed request: ${description}`); continue; }
    if (url.pathname === '/' || url.pathname === '/index.html') { allowed.push({ kind: 'page', description }); continue; }
    if (staticAssets.has(url.pathname)) { allowed.push({ kind: 'JS/CSS loaded by the page itself', description }); continue; }
    if (url.pathname.endsWith('.wasm')) { problems.push(`WebAssembly download (glslang/twgsl?): ${description}`); continue; }
    if (/\.m?js$/.test(url.pathname)) { problems.push(`lazy JS chunk (not referenced by index.html or its static imports): ${description}`); continue; }
    problems.push(`unexpected file: ${description}`);
  }
  return { allowed, problems };
}

async function checkProductionNetwork() {
  if (process.env.SKIP_BUILD !== '1') {
    console.log('S14: running "npm run build" ...');
    const build = await runCommand('npm', ['run', 'build'], { cwd: projectRoot });
    if (build.exitCode !== 0) {
      addRow('S14', false, `"npm run build" failed (exit ${build.exitCode}): ${build.output.trim().split('\n').slice(-6).join(' / ')}`);
      return null;
    }
  }
  if (!existsSync(path.join(distDirectory, 'index.html'))) {
    addRow('S14', false, `${distDirectory}/index.html does not exist`);
    return null;
  }
  const staticAssets = findStaticallyLoadedAssets(distDirectory);
  const staticServer = await startStaticServer(distDirectory, 0);
  const server = { mode: 'dist', baseUrl: staticServer.url, warnings: [], description: `the production build at ${staticServer.url}`, close: () => staticServer.close() };
  try {
    const target = await openMillersPlanet({ server, recordNetwork: true });
    try {
      console.log(`S14: page ready; recording network requests for ${renderSecondsForS14} s of rendering ...`);
      await sleep(renderSecondsForS14 * 1000);
      const requests = target.page.networkRequests.slice();
      const { allowed, problems } = classifyRequests(requests, staticServer.url, staticAssets);
      const summary = `${requests.length} request(s): ${allowed.filter((entry) => entry.kind === 'page').length} page, ${allowed.filter((entry) => entry.kind.startsWith('JS')).length} JS/CSS file(s) named by index.html or its static imports, ${allowed.filter((entry) => entry.kind === 'data URL').length} data URL(s)`;
      addRow('S14', problems.length === 0, problems.length ? `${summary}; NOT ALLOWED: ${problems.join('; ')}` : `${summary}; nothing else was fetched`);
      return { requests, staticAssets: [...staticAssets], allowed, problems };
    } finally {
      await target.close();
    }
  } finally {
    await staticServer.close();
  }
}

async function runPageSpikeItems() {
  let target;
  try {
    target = await openMillersPlanet();
  } catch (error) {
    addRow('runAll', false, `the app did not start: ${error.message.split('\n')[0]}`);
    return null;
  }
  try {
    const hasSpike = await target.page.evaluate("typeof window.millersPlanet?.debug?.spike?.runAll === 'function'");
    if (!hasSpike) {
      addRow('runAll', false, 'millersPlanet.debug.spike.runAll is missing');
      return null;
    }
    const startUpErrors = target.page.pageErrors();
    if (startUpErrors.length) addRow('console', false, `errors while the app started: ${startUpErrors.slice(0, 3).map((event) => event.text).join(' | ')}`);
    const eventCountBeforeRunAll = target.page.pageEvents.length;
    console.log('Running millersPlanet.debug.spike.runAll() in the app (this can take a few minutes) ...');
    const results = await target.page.evaluate(pageExpression('window.millersPlanet.debug.spike.runAll()'), { timeoutMs: 15 * 60 * 1000 });
    const errorsDuringRunAll = target.page.pageEvents.slice(eventCountBeforeRunAll).filter((event) => event.level === 'error');
    if (errorsDuringRunAll.length) console.log(`Note: the page logged ${errorsDuringRunAll.length} error message(s) during runAll(). S12 and S13 plant broken shaders on purpose, so some are expected; they are kept in the JSON file.`);
    if (!Array.isArray(results)) {
      addRow('runAll', false, `runAll() returned ${JSON.stringify(results)?.slice(0, 200)} instead of a list`);
      return results;
    }
    for (const result of results) {
      const malformed = !result || typeof result.name !== 'string' || typeof result.pass !== 'boolean';
      if (malformed) {
        addRow(result?.name || '?', false, `malformed spike result ${JSON.stringify(result)?.slice(0, 200)}`);
        continue;
      }
      addRow(result.name, result.pass, typeof result.details === 'string' ? result.details : JSON.stringify(result.details), result.fallbackUsed);
    }
    for (const name of PAGE_SPIKE_ITEMS) {
      if (results.some((result) => result?.name === name)) continue;
      const owningPhase = PHASE_THAT_OWNS_DEFERRED_ITEM[name];
      if (owningPhase && spikePhase < owningPhase) addDeferredRow(name, `checked in phase ${owningPhase}, which builds that texture type (ruling of 2026-10-18 in the project doc); run with PHASE=${owningPhase} to require it`);
      else addRow(name, false, 'missing from runAll() results');
    }
    const leftover = await target.page.evaluate(pageExpression('(() => { const stats = window.millersPlanet.stats(); return { gpuErrors: stats.gpuErrors || [], deviceLost: stats.deviceLost }; })()'));
    addRow('clean-up', leftover.gpuErrors.length === 0 && leftover.deviceLost !== true, leftover.gpuErrors.length ? `GPU errors left after runAll(): ${leftover.gpuErrors.slice(0, 3).map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry))).join(' | ')}` : `no GPU errors left after runAll()${leftover.deviceLost ? ', but the device is lost' : ''}`);
    pageConsoleDuringRunAll = target.page.pageEvents.slice(eventCountBeforeRunAll).map((event) => `[${event.kind}:${event.level}] ${event.text}`);
    return results;
  } catch (error) {
    addRow('runAll', false, error.message.split('\n')[0]);
    return null;
  } finally {
    await target.close();
  }
}

console.log('S0c: timestamp precision probe ...');
const probe = await runTimestampProbe();
const probeChecks = checkTimestampProbe(probe);
const precisionCheck = probeChecks.find((check) => check.name === 'timestamp precision') || probeChecks[0];
addRow('S0c', probeChecks.every((check) => check.status !== 'FAIL'), precisionCheck.detail);
const pageResults = await runPageSpikeItems();
const networkResults = process.env.SKIP_S14 === '1' ? (addRow('S14', false, 'skipped because SKIP_S14=1'), null) : await checkProductionNetwork();

const order = (name) => {
  const index = ['S0', 'S0b', 'S0c', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10', 'S11', 'S12', 'S13', 'S14'].indexOf(name);
  return index === -1 ? 100 : index;
};
rows.sort((first, second) => order(first.name) - order(second.name));
console.log(`\n${formatTable(['item', 'result', 'details'], rows.map((row) => [row.name, row.deferred ? 'DEFERRED' : row.pass ? (row.fallbackUsed ? `PASS (fallback: ${row.fallbackUsed})` : 'PASS') : 'FAIL', row.details.length > 220 ? `${row.details.slice(0, 217)}...` : row.details]), { rightAlignFrom: 99 })}`);

const evidencePath = path.join(evidenceDirectory(), `${spikePhase}-spike.json`);
mkdirSync(path.dirname(evidencePath), { recursive: true });
writeFileSync(evidencePath, JSON.stringify({ tool: 'spike.mjs', createdAt: new Date().toISOString(), rows, timestampProbe: probe, pageResults, pageConsoleDuringRunAll, network: networkResults }, null, 1));
console.log(`\nWrote ${evidencePath}`);

const s0 = rows.find((row) => row.name === 'S0');
if (s0 && !s0.pass) console.log('\nSTOP: S0 failed (a compute shader writing a texture that a material samples in the same frame). The plan says to stop and ask the user before going on.');
const failedRows = rows.filter((row) => !row.pass);
const deferredRows = rows.filter((row) => row.deferred);
console.log(failedRows.length ? `\nspike FAILED: ${failedRows.map((row) => row.name).join(', ')}` : `\nspike PASSED: every required item passed (fallbacks, if any, are named above)${deferredRows.length ? `; deferred to a later phase: ${deferredRows.map((row) => row.name).join(', ')}` : ''}.`);
process.exit(failedRows.length ? 1 : 0);
