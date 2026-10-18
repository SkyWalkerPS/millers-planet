import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const STDERR_TAIL_CHARACTER_LIMIT = 16384;
const DEFAULT_EVALUATE_TIMEOUT_MS = 120000;
const CONSOLE_LINES_IN_ERRORS = 40;

export const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

const KEY_DEFINITIONS_BY_CODE = buildKeyDefinitions();

function buildKeyDefinitions() {
  const definitions = {};
  for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    definitions[`Key${letter}`] = { key: letter.toLowerCase(), shiftedKey: letter, keyCode: letter.charCodeAt(0), printable: true };
  }
  const shiftedDigits = ')!@#$%^&*(';
  for (let digit = 0; digit <= 9; digit++) {
    definitions[`Digit${digit}`] = { key: String(digit), shiftedKey: shiftedDigits[digit], keyCode: 48 + digit, printable: true };
  }
  Object.assign(definitions, {
    Equal: { key: '=', shiftedKey: '+', keyCode: 187, printable: true },
    Minus: { key: '-', shiftedKey: '_', keyCode: 189, printable: true },
    BracketLeft: { key: '[', shiftedKey: '{', keyCode: 219, printable: true },
    BracketRight: { key: ']', shiftedKey: '}', keyCode: 221, printable: true },
    Comma: { key: ',', shiftedKey: '<', keyCode: 188, printable: true },
    Period: { key: '.', shiftedKey: '>', keyCode: 190, printable: true },
    Slash: { key: '/', shiftedKey: '?', keyCode: 191, printable: true },
    NumpadAdd: { key: '+', keyCode: 107, printable: true, location: 3 },
    NumpadSubtract: { key: '-', keyCode: 109, printable: true, location: 3 },
    Space: { key: ' ', keyCode: 32, printable: true },
    Enter: { key: 'Enter', keyCode: 13 },
    Escape: { key: 'Escape', keyCode: 27 },
    Tab: { key: 'Tab', keyCode: 9 },
    Backspace: { key: 'Backspace', keyCode: 8 },
    ArrowLeft: { key: 'ArrowLeft', keyCode: 37 },
    ArrowUp: { key: 'ArrowUp', keyCode: 38 },
    ArrowRight: { key: 'ArrowRight', keyCode: 39 },
    ArrowDown: { key: 'ArrowDown', keyCode: 40 },
    ShiftLeft: { key: 'Shift', keyCode: 16, location: 1 },
    ShiftRight: { key: 'Shift', keyCode: 16, location: 2 },
    ControlLeft: { key: 'Control', keyCode: 17, location: 1 },
    ControlRight: { key: 'Control', keyCode: 17, location: 2 },
    AltLeft: { key: 'Alt', keyCode: 18, location: 1 },
    AltRight: { key: 'Alt', keyCode: 18, location: 2 },
    MetaLeft: { key: 'Meta', keyCode: 91, location: 1 },
    MetaRight: { key: 'Meta', keyCode: 93, location: 2 },
  });
  return definitions;
}

export function modifierBitmask(modifiers) {
  if (typeof modifiers === 'number') return modifiers;
  if (!modifiers) return 0;
  return modifiers.reduce((bits, name) => {
    if (!(name in MODIFIER_BITS)) throw new Error(`Unknown modifier key "${name}" (use Alt, Control, Meta or Shift)`);
    return bits | MODIFIER_BITS[name];
  }, 0);
}

export const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function withTimeout(promise, timeoutMs, describeTimeout) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(describeTimeout())), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function readImageDimensions(bytes) {
  if (bytes.length > 24 && bytes.readUInt32BE(0) === 0x89504e47) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset++; continue; }
      const marker = bytes[offset + 1];
      const segmentLength = bytes.readUInt16BE(offset + 2);
      const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isStartOfFrame) return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
      offset += 2 + segmentLength;
    }
  }
  return { width: undefined, height: undefined };
}

const liveChromeLaunches = new Set();
let exitHandlersInstalled = false;

function killEveryLiveChromeNow() {
  for (const launch of liveChromeLaunches) {
    if (launch.chromeProcess.exitCode === null && launch.chromeProcess.signalCode === null) {
      try { launch.chromeProcess.kill('SIGKILL'); } catch {}
    }
    try { rmSync(launch.userDataDirectory, { recursive: true, force: true }); } catch {}
  }
  liveChromeLaunches.clear();
}

function installExitHandlersOnce() {
  if (exitHandlersInstalled) return;
  exitHandlersInstalled = true;
  process.on('exit', killEveryLiveChromeNow);
  for (const [signalName, exitCode] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
    process.once(signalName, () => {
      killEveryLiveChromeNow();
      process.exit(exitCode);
    });
  }
}

class CdpConnection {
  constructor(socket) {
    this.socket = socket;
    this.nextMessageId = 1;
    this.pendingReplies = new Map();
    this.eventListeners = new Map();
    this.isClosed = false;
    socket.addEventListener('message', (event) => this.handleMessage(JSON.parse(event.data)));
    socket.addEventListener('close', () => {
      this.isClosed = true;
      this.rejectPendingReplies('DevTools connection closed');
    });
  }

  static open(webSocketUrl) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(webSocketUrl);
      socket.addEventListener('open', () => resolve(new CdpConnection(socket)));
      socket.addEventListener('error', () => reject(new Error(`Could not connect to Chrome at ${webSocketUrl}`)));
    });
  }

  rejectPendingReplies(reason) {
    for (const pending of this.pendingReplies.values()) pending.reject(new Error(`${pending.method}: ${reason}`));
    this.pendingReplies.clear();
  }

  handleMessage(message) {
    if (message.id !== undefined) {
      const pending = this.pendingReplies.get(message.id);
      if (!pending) return;
      this.pendingReplies.delete(message.id);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}${message.error.data ? ` (${message.error.data})` : ''}`));
      else pending.resolve(message.result);
      return;
    }
    const listeners = this.eventListeners.get(`${message.sessionId || ''}|${message.method}`);
    if (!listeners) return;
    for (const listener of [...listeners]) listener(message.params);
  }

  send(method, params = {}, sessionId = undefined) {
    if (this.isClosed) return Promise.reject(new Error(`${method}: DevTools connection is already closed`));
    const id = this.nextMessageId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pendingReplies.set(id, { resolve, reject, method });
      this.socket.send(JSON.stringify(payload));
    });
  }

  on(method, listener, sessionId = undefined) {
    const listenerKey = `${sessionId || ''}|${method}`;
    if (!this.eventListeners.has(listenerKey)) this.eventListeners.set(listenerKey, new Set());
    this.eventListeners.get(listenerKey).add(listener);
    return () => this.eventListeners.get(listenerKey)?.delete(listener);
  }

  async newPage() {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new CdpPage(this, sessionId, targetId);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Log.enable');
    await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    return page;
  }

  async close() {
    if (this.isClosed) return;
    let closeTimer;
    const closeTimeout = new Promise((resolve) => { closeTimer = setTimeout(resolve, 3000); });
    try {
      await Promise.race([this.send('Browser.close').catch(() => undefined), closeTimeout]);
    } finally {
      clearTimeout(closeTimer);
    }
    this.socket.close();
  }
}

class CdpPage {
  constructor(connection, sessionId, targetId) {
    this.connection = connection;
    this.sessionId = sessionId;
    this.targetId = targetId;
    this.pageEvents = [];
    this.networkRequests = [];
    this.networkLogStarted = false;
    this.mousePosition = { x: 0, y: 0 };
    this.pressedMouseButtons = 0;
    this.on('Runtime.consoleAPICalled', (params) => {
      const text = params.args.map((argument) => (argument.value !== undefined ? String(argument.value) : argument.description || argument.type)).join(' ');
      const level = params.type === 'warning' ? 'warning' : params.type === 'assert' ? 'error' : params.type;
      this.pageEvents.push({ kind: 'console', level, text, time: Date.now() });
    });
    this.on('Runtime.exceptionThrown', (params) => {
      const details = params.exceptionDetails;
      const where = details.url ? ` (${details.url}:${(details.lineNumber ?? 0) + 1})` : '';
      this.pageEvents.push({ kind: 'exception', level: 'error', text: `${details.exception?.description || details.text}${where}`, time: Date.now() });
    });
    this.on('Log.entryAdded', (params) => {
      const entry = params.entry;
      this.pageEvents.push({ kind: 'log', level: entry.level, source: entry.source, text: `${entry.text}${entry.url ? ` (${entry.url})` : ''}`, time: Date.now() });
    });
  }

  get consoleMessages() {
    return this.pageEvents.map((event) => `[${event.kind === 'console' ? event.level : event.kind === 'log' ? `log:${event.level}` : 'exception'}] ${event.text}`);
  }

  consoleTail(lineCount = CONSOLE_LINES_IN_ERRORS) {
    const lines = this.consoleMessages;
    if (!lines.length) return '(the page logged nothing)';
    return lines.slice(-lineCount).join('\n');
  }

  pageErrors({ ignorePatterns = [] } = {}) {
    return this.pageEvents.filter((event) => event.level === 'error' && !ignorePatterns.some((pattern) => pattern.test(event.text)));
  }

  pageWarnings() {
    return this.pageEvents.filter((event) => event.level === 'warning');
  }

  throwIfPageErrors({ ignorePatterns = [], context = 'The page reported errors' } = {}) {
    const errors = this.pageErrors({ ignorePatterns });
    if (errors.length) throw new Error(`${context}:\n${errors.map((event) => `  [${event.kind}] ${event.text}`).join('\n')}`);
  }

  send(method, params = {}) {
    return this.connection.send(method, params, this.sessionId);
  }

  on(method, listener) {
    return this.connection.on(method, listener, this.sessionId);
  }

  waitForEvent(method, { timeoutMs = 30000, predicate = () => true, describeTimeout = () => `Timed out after ${timeoutMs} ms waiting for ${method}` } = {}) {
    let removeListener = () => {};
    let timer;
    let settle;
    const promise = new Promise((resolve, reject) => {
      settle = { resolve, reject };
      removeListener = this.on(method, (params) => {
        if (!predicate(params)) return;
        removeListener();
        clearTimeout(timer);
        resolve(params);
      });
      timer = setTimeout(() => {
        removeListener();
        reject(new Error(describeTimeout()));
      }, timeoutMs);
    });
    promise.cancel = () => {
      removeListener();
      clearTimeout(timer);
      settle.resolve(undefined);
    };
    return promise;
  }

  async setViewport(width, height, deviceScaleFactor = 1) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile: false });
  }

  async addScriptToEvaluateOnNewDocument(source) {
    return this.send('Page.addScriptToEvaluateOnNewDocument', { source });
  }

  async goto(url, { timeoutMs = 60000 } = {}) {
    const loaded = this.waitForEvent('Page.loadEventFired', { timeoutMs, describeTimeout: () => `Timed out after ${timeoutMs} ms loading ${url}\nConsole:\n${this.consoleTail()}` });
    let navigation;
    try {
      navigation = await this.send('Page.navigate', { url });
    } catch (error) {
      loaded.cancel();
      throw error;
    }
    if (navigation.errorText) {
      loaded.cancel();
      throw new Error(`Could not open ${url}: ${navigation.errorText}`);
    }
    await loaded;
  }

  async reload({ timeoutMs = 60000, ignoreCache = true } = {}) {
    const loaded = this.waitForEvent('Page.loadEventFired', { timeoutMs, describeTimeout: () => `Timed out after ${timeoutMs} ms reloading the page` });
    try {
      await this.send('Page.reload', { ignoreCache });
    } catch (error) {
      loaded.cancel();
      throw error;
    }
    await loaded;
  }

  async evaluate(expression, { timeoutMs = DEFAULT_EVALUATE_TIMEOUT_MS, userGesture = false } = {}) {
    const evaluation = this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture });
    const result = await withTimeout(evaluation, timeoutMs, () => `The page did not answer within ${timeoutMs} ms while evaluating:\n  ${expression.slice(0, 300)}\nConsole:\n${this.consoleTail()}`);
    if (result.exceptionDetails) {
      const description = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
      throw new Error(`Page evaluation failed: ${description}`);
    }
    return result.result.value;
  }

  async evaluateFunction(functionSource, argumentList = [], options = {}) {
    const serialisedArguments = argumentList.map((argument) => (argument === undefined ? 'undefined' : JSON.stringify(argument))).join(', ');
    return this.evaluate(`(${functionSource})(${serialisedArguments})`, options);
  }

  async waitFor(expression, { timeoutMs = 30000, pollMs = 100, describe = expression } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        const value = await this.evaluate(expression, { timeoutMs: Math.max(1000, deadline - Date.now()) });
        if (value) return value;
        lastError = null;
      } catch (error) {
        lastError = error;
      }
      await sleep(pollMs);
    }
    throw new Error(`Timed out after ${timeoutMs} ms waiting for: ${describe}${lastError ? `\nLast error: ${lastError.message}` : ''}\nConsole:\n${this.consoleTail()}`);
  }

  async keyDown(code, { modifiers = 0 } = {}) {
    const definition = KEY_DEFINITIONS_BY_CODE[code];
    if (!definition) throw new Error(`No key definition for code "${code}"`);
    const modifierBits = modifierBitmask(modifiers);
    const shifted = (modifierBits & MODIFIER_BITS.Shift) !== 0;
    const key = shifted && definition.shiftedKey ? definition.shiftedKey : definition.key;
    const producesText = definition.printable && (modifierBits & (MODIFIER_BITS.Control | MODIFIER_BITS.Meta)) === 0;
    await this.send('Input.dispatchKeyEvent', {
      type: producesText ? 'keyDown' : 'rawKeyDown',
      key,
      code,
      windowsVirtualKeyCode: definition.keyCode,
      modifiers: modifierBits,
      location: definition.location ?? 0,
      ...(producesText ? { text: key, unmodifiedText: key } : {}),
    });
  }

  async keyUp(code, { modifiers = 0 } = {}) {
    const definition = KEY_DEFINITIONS_BY_CODE[code];
    if (!definition) throw new Error(`No key definition for code "${code}"`);
    const modifierBits = modifierBitmask(modifiers);
    const shifted = (modifierBits & MODIFIER_BITS.Shift) !== 0;
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: shifted && definition.shiftedKey ? definition.shiftedKey : definition.key,
      code,
      windowsVirtualKeyCode: definition.keyCode,
      modifiers: modifierBits,
      location: definition.location ?? 0,
    });
  }

  async keyPress(code, { modifiers = 0, holdMs = 0, afterMs = 30 } = {}) {
    await this.keyDown(code, { modifiers });
    if (holdMs) await sleep(holdMs);
    await this.keyUp(code, { modifiers });
    if (afterMs) await sleep(afterMs);
  }

  async mouseMove(x, y, { modifiers = 0 } = {}) {
    this.mousePosition = { x, y };
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: this.pressedMouseButtons, modifiers: modifierBitmask(modifiers) });
  }

  async mouseMoveBy(deltaX, deltaY, { steps = 1, stepDelayMs = 0 } = {}) {
    const start = { ...this.mousePosition };
    for (let step = 1; step <= steps; step++) {
      await this.mouseMove(start.x + (deltaX * step) / steps, start.y + (deltaY * step) / steps);
      if (stepDelayMs) await sleep(stepDelayMs);
    }
  }

  async mousePress(x, y, { button = 'left', clickCount = 1, modifiers = 0 } = {}) {
    this.mousePosition = { x, y };
    this.pressedMouseButtons |= mouseButtonBit(button);
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: this.pressedMouseButtons, clickCount, modifiers: modifierBitmask(modifiers) });
  }

  async mouseRelease(x, y, { button = 'left', clickCount = 1, modifiers = 0 } = {}) {
    this.mousePosition = { x, y };
    this.pressedMouseButtons &= ~mouseButtonBit(button);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: this.pressedMouseButtons, clickCount, modifiers: modifierBitmask(modifiers) });
  }

  async click(x, y, { button = 'left', modifiers = 0, holdMs = 0 } = {}) {
    await this.mouseMove(x, y);
    await this.mousePress(x, y, { button, modifiers });
    if (holdMs) await sleep(holdMs);
    await this.mouseRelease(x, y, { button, modifiers });
  }

  async wheel({ x, y, deltaX = 0, deltaY = 0, modifiers = 0 }) {
    this.mousePosition = { x, y };
    await this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY, modifiers: modifierBitmask(modifiers) });
  }

  async screenshot(filePath, { format = 'png', quality, clip } = {}) {
    const parameters = { format, captureBeyondViewport: false };
    if (format === 'jpeg' || format === 'webp') parameters.quality = quality ?? 90;
    if (clip) parameters.clip = { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: clip.scale ?? 1 };
    const { data } = await this.send('Page.captureScreenshot', parameters);
    const bytes = Buffer.from(data, 'base64');
    if (filePath) writeFileSync(filePath, bytes);
    return { filePath, byteLength: bytes.length, ...readImageDimensions(bytes) };
  }

  async startNetworkLog() {
    if (this.networkLogStarted) return this.networkRequests;
    this.networkLogStarted = true;
    const latestRequestById = new Map();
    this.on('Network.requestWillBeSent', (params) => {
      const record = {
        requestId: params.requestId,
        url: params.request.url,
        method: params.request.method,
        resourceType: params.type,
        initiatorType: params.initiator?.type,
        timeMs: params.timestamp * 1000,
        status: null,
        mimeType: null,
        failed: null,
        finished: false,
      };
      this.networkRequests.push(record);
      latestRequestById.set(params.requestId, record);
    });
    this.on('Network.responseReceived', (params) => {
      const record = latestRequestById.get(params.requestId);
      if (!record) return;
      record.status = params.response.status;
      record.mimeType = params.response.mimeType;
    });
    this.on('Network.loadingFailed', (params) => {
      const record = latestRequestById.get(params.requestId);
      if (!record) return;
      record.failed = params.errorText || 'failed';
      if (params.canceled) record.failed += ' (cancelled)';
      if (params.blockedReason) record.failed += ` (blocked: ${params.blockedReason})`;
    });
    this.on('Network.loadingFinished', (params) => {
      const record = latestRequestById.get(params.requestId);
      if (record) record.finished = true;
    });
    await this.send('Network.enable', {});
    return this.networkRequests;
  }
}

function mouseButtonBit(button) {
  return { left: 1, right: 2, middle: 4, back: 8, forward: 16 }[button] ?? 0;
}

export async function launchChrome({ headless = true, extraArgs = [], chromePath = process.env.CHROME_PATH || DEFAULT_CHROME_PATH, webGpuDeveloperFlags = true } = {}) {
  installExitHandlersOnce();
  const userDataDirectory = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'millers-planet-chrome-'));
  const chromeArguments = [
    headless ? '--headless=new' : null,
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDirectory}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    webGpuDeveloperFlags ? '--enable-unsafe-webgpu' : null,
    webGpuDeveloperFlags ? '--enable-features=WebGPUDeveloperFeatures' : null,
    '--hide-scrollbars',
    '--mute-audio',
    ...extraArgs,
    'about:blank',
  ].filter(Boolean);
  const chromeProcess = spawn(chromePath, chromeArguments, { stdio: ['ignore', 'ignore', 'pipe'] });
  const launch = { chromeProcess, userDataDirectory };
  liveChromeLaunches.add(launch);
  let stderrTail = '';
  const appendToStderrTail = (chunk) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_CHARACTER_LIMIT);
  };
  let webSocketUrl;
  try {
    webSocketUrl = await new Promise((resolve, reject) => {
      let startupText = '';
      const timer = setTimeout(() => finish(new Error(`Chrome did not report a DevTools address within 30 s:\n${startupText}`)), 30000);
      const onStartupData = (chunk) => {
        startupText += chunk.toString();
        const match = startupText.match(/DevTools listening on (ws:\/\/\S+)/);
        if (match) finish(null, match[1]);
      };
      const onEarlyExit = (code, signal) => finish(new Error(`Chrome exited before it was ready (code ${code}, signal ${signal}):\n${startupText}`));
      const onSpawnError = (error) => finish(new Error(`Could not start Chrome at ${chromePath}: ${error.message}`));
      function finish(error, url) {
        clearTimeout(timer);
        chromeProcess.stderr.off('data', onStartupData);
        chromeProcess.off('exit', onEarlyExit);
        chromeProcess.off('error', onSpawnError);
        chromeProcess.stderr.on('data', appendToStderrTail);
        appendToStderrTail(startupText);
        if (error) reject(error);
        else resolve(url);
      }
      chromeProcess.stderr.on('data', onStartupData);
      chromeProcess.on('exit', onEarlyExit);
      chromeProcess.on('error', onSpawnError);
    });
  } catch (error) {
    await stopChromeProcess(launch, { gracefulWaitMs: 0 });
    throw error;
  }
  let connection;
  try {
    connection = await CdpConnection.open(webSocketUrl);
  } catch (error) {
    await stopChromeProcess(launch, { gracefulWaitMs: 0 });
    throw error;
  }
  connection.chromeProcess = chromeProcess;
  connection.userDataDirectory = userDataDirectory;
  connection.stderrTail = () => stderrTail;
  connection.shutdown = async () => {
    try {
      await connection.close();
    } finally {
      await stopChromeProcess(launch, { gracefulWaitMs: 3000 });
    }
  };
  return connection;
}

function isProcessRunning(childProcess) {
  return childProcess.exitCode === null && childProcess.signalCode === null;
}

function waitForProcessExit(childProcess, timeoutMs) {
  if (!isProcessRunning(childProcess)) return Promise.resolve(true);
  if (timeoutMs <= 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      childProcess.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    childProcess.once('exit', onExit);
  });
}

async function stopChromeProcess(launch, { gracefulWaitMs }) {
  const { chromeProcess, userDataDirectory } = launch;
  if (!(await waitForProcessExit(chromeProcess, gracefulWaitMs))) {
    try { chromeProcess.kill('SIGTERM'); } catch {}
    if (!(await waitForProcessExit(chromeProcess, 3000))) {
      try { chromeProcess.kill('SIGKILL'); } catch {}
      await waitForProcessExit(chromeProcess, 2000);
    }
  }
  chromeProcess.stderr?.removeAllListeners('data');
  chromeProcess.stderr?.destroy();
  rmSync(userDataDirectory, { recursive: true, force: true });
  liveChromeLaunches.delete(launch);
}

export function fileUrl(absolutePath, query = '') {
  const url = pathToFileURL(absolutePath);
  if (query) url.search = typeof query === 'string' ? query : new URLSearchParams(query).toString();
  return url.href;
}
