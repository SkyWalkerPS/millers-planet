import net from 'node:net';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, sleep } from './cdp.mjs';
import { startStaticServer } from './serve.mjs';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_VIEWPORT = { width: 1728, height: 1117, deviceScaleFactor: 2 };
export const DEFAULT_READY_TIMEOUT_MS = Number(process.env.READY_TIMEOUT_MS || 60000);

export function viewportFromEnvironment() {
  const [width, height] = (process.env.VIEWPORT || `${DEFAULT_VIEWPORT.width}x${DEFAULT_VIEWPORT.height}`).split('x').map(Number);
  const deviceScaleFactor = Number(process.env.DPR || DEFAULT_VIEWPORT.deviceScaleFactor);
  if (!(width > 0 && height > 0 && deviceScaleFactor > 0)) throw new Error(`VIEWPORT must look like 1728x1117 and DPR like 2 (got VIEWPORT=${process.env.VIEWPORT}, DPR=${process.env.DPR})`);
  return { width, height, deviceScaleFactor };
}

export function evidenceDirectory() {
  return process.env.EVIDENCE_DIRECTORY ? path.resolve(process.env.EVIDENCE_DIRECTORY) : path.join(projectRoot, 'evidence');
}

export function findFreePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const probeServer = net.createServer();
    probeServer.once('error', reject);
    probeServer.listen(0, host, () => {
      const { port } = probeServer.address();
      probeServer.close(() => resolve(port));
    });
  });
}

function listFilesRecursively(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFilesRecursively(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

export function findSourcesNewerThanBuild(root = projectRoot) {
  const builtIndex = path.join(root, 'dist', 'index.html');
  if (!existsSync(builtIndex)) return [];
  const buildTime = statSync(builtIndex).mtimeMs;
  const candidates = [...listFilesRecursively(path.join(root, 'src')), path.join(root, 'index.html'), path.join(root, 'vite.config.js')].filter((filePath) => existsSync(filePath));
  return candidates.filter((filePath) => statSync(filePath).mtimeMs > buildTime).map((filePath) => path.relative(root, filePath));
}

export async function startMillersPlanetServer({ serve = process.env.SERVE || 'dev', root = projectRoot, pageUrl = process.env.PAGE_URL } = {}) {
  if (pageUrl) {
    return { mode: 'url', baseUrl: pageUrl, warnings: [], description: `the page at ${pageUrl} (PAGE_URL)`, close: async () => {} };
  }
  if (serve === 'dev') {
    const port = await findFreePort();
    const vite = await import('vite');
    const configFilePath = path.join(root, 'vite.config.js');
    const devServer = await vite.createServer({
      root,
      configFile: existsSync(configFilePath) ? configFilePath : false,
      logLevel: process.env.VITE_LOG_LEVEL || 'warn',
      clearScreen: false,
      server: { host: '127.0.0.1', port, strictPort: true, open: false, hmr: false },
    });
    await devServer.listen();
    const baseUrl = `http://127.0.0.1:${port}/`;
    const reportedUrls = devServer.resolvedUrls?.local || [];
    if (reportedUrls.length && !reportedUrls.some((url) => url.includes(`:${port}`))) {
      await devServer.close();
      throw new Error(`Vite did not start on the port we asked for (${port}); it reported ${reportedUrls.join(', ')}`);
    }
    return { mode: 'dev', baseUrl, warnings: [], description: `the Vite dev server at ${baseUrl}`, close: () => devServer.close() };
  }
  if (serve === 'dist') {
    const distDirectory = path.join(root, 'dist');
    if (!existsSync(path.join(distDirectory, 'index.html'))) throw new Error(`SERVE=dist needs ${path.join(distDirectory, 'index.html')}, which does not exist. Run "npm run build" first.`);
    const warnings = [];
    const newerSources = findSourcesNewerThanBuild(root);
    if (newerSources.length) {
      warnings.push(`dist/ may be out of date: ${newerSources.length} source file(s) changed after the last build (${newerSources.slice(0, 5).join(', ')}${newerSources.length > 5 ? ', ...' : ''}). Run "npm run build" to rebuild.`);
    }
    const staticServer = await startStaticServer(distDirectory, 0);
    return { mode: 'dist', baseUrl: staticServer.url, warnings, description: `the production build in dist/ at ${staticServer.url}`, close: () => staticServer.close() };
  }
  throw new Error(`Unknown SERVE value "${serve}". Use SERVE=dev (Vite dev server), SERVE=dist (the built dist/ folder) or PAGE_URL=<address>.`);
}

export function buildPageUrl(baseUrl, query = {}) {
  const url = new URL(baseUrl);
  for (const [name, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === false) continue;
    url.searchParams.set(name, String(value));
  }
  for (const [name, value] of new URLSearchParams(process.env.QUERY || '')) url.searchParams.set(name, value);
  return url.href;
}

const READY_PROBE_FUNCTION = `() => {
  const api = window.millersPlanet;
  if (!api) return { state: 'no-api' };
  if (api.isReady === true) return { state: 'ready' };
  if (!window.harnessReadyWatcherAttached && api.ready && typeof api.ready.then === 'function') {
    window.harnessReadyWatcherAttached = true;
    api.ready.then(
      (value) => { window.harnessReadyOutcome = value === false ? 'resolved-false' : 'resolved'; },
      (error) => { window.harnessReadyOutcome = 'rejected: ' + ((error && error.message) || String(error)); },
    );
  }
  return { state: 'waiting', readyOutcome: window.harnessReadyOutcome || null };
}`;

export async function waitForMillersPlanetReady(page, { timeoutMs = DEFAULT_READY_TIMEOUT_MS, checkGpuErrors = true } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastState = 'not checked';
  while (Date.now() < deadline) {
    let probe;
    try {
      probe = await page.evaluateFunction(READY_PROBE_FUNCTION, [], { timeoutMs: 10000 });
    } catch (error) {
      lastState = `page busy or reloading (${error.message.split('\n')[0]})`;
      await sleep(200);
      continue;
    }
    lastState = probe.readyOutcome ? `${probe.state}, ready promise ${probe.readyOutcome}` : probe.state;
    if (probe.state === 'ready') break;
    if (probe.readyOutcome === 'resolved-false' || probe.readyOutcome?.startsWith('rejected')) {
      throw new Error(`The app failed to start: millersPlanet.ready ${probe.readyOutcome}.\nConsole:\n${page.consoleTail()}`);
    }
    await sleep(100);
  }
  if (lastState !== 'ready') {
    throw new Error(`The app did not become ready within ${Math.round(timeoutMs / 1000)} s (last state: ${lastState}).\nConsole:\n${page.consoleTail()}`);
  }
  if (checkGpuErrors) {
    const gpuErrors = await page.evaluate('(() => { const stats = window.millersPlanet.stats(); return (stats && stats.gpuErrors) || []; })()');
    if (gpuErrors.length) {
      throw new Error(`The app started with GPU errors (stats().gpuErrors):\n${gpuErrors.map((entry) => `  ${typeof entry === 'string' ? entry : JSON.stringify(entry)}`).join('\n')}\nConsole:\n${page.consoleTail()}`);
    }
  }
}

export async function openMillersPlanet({
  query = {},
  viewport,
  deviceScaleFactor,
  serve,
  server = null,
  readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
  recordNetwork = false,
  scriptsBeforeLoad = [],
  waitUntilReady = true,
  checkGpuErrors = true,
  chromeOptions = {},
} = {}) {
  const environmentViewport = viewportFromEnvironment();
  const width = viewport?.width ?? environmentViewport.width;
  const height = viewport?.height ?? environmentViewport.height;
  const scaleFactor = deviceScaleFactor ?? viewport?.deviceScaleFactor ?? environmentViewport.deviceScaleFactor;
  const ownsServer = !server;
  const activeServer = server || (await startMillersPlanetServer({ serve }));
  let browser = null;
  try {
    for (const warning of ownsServer ? activeServer.warnings : []) console.warn(`WARNING: ${warning}`);
    browser = await launchChrome(chromeOptions);
    const page = await browser.newPage();
    await page.setViewport(width, height, scaleFactor);
    if (recordNetwork) await page.startNetworkLog();
    for (const script of scriptsBeforeLoad) await page.addScriptToEvaluateOnNewDocument(script);
    const url = buildPageUrl(activeServer.baseUrl, query);
    await page.goto(url, { timeoutMs: readyTimeoutMs });
    if (waitUntilReady) await waitForMillersPlanetReady(page, { timeoutMs: readyTimeoutMs, checkGpuErrors });
    const openedBrowser = browser;
    return {
      browser: openedBrowser,
      page,
      url,
      server: activeServer,
      viewport: { width, height, deviceScaleFactor: scaleFactor },
      close: async () => {
        try {
          await openedBrowser.shutdown();
        } finally {
          if (ownsServer) await activeServer.close();
        }
      },
    };
  } catch (error) {
    try {
      if (browser) await browser.shutdown();
    } finally {
      if (ownsServer) await activeServer.close();
    }
    throw error;
  }
}
