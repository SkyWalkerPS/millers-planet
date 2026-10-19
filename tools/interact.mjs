import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { sleep } from './cdp.mjs';
import { evidenceDirectory, openMillersPlanet, startMillersPlanetServer } from './target.mjs';
import { pageExpression } from './page-results.mjs';

const phase = Number(process.env.PHASE || 2);
const CHECK_TITLES = {
  1: 'start-up: ready, full-resolution canvas, no console errors',
  2: 'opening state: preset 0, player camera behind the astronaut, ship nearby, nothing locked or playing',
  3: 'only the clocks and the wave countdown on screen, two top-left glass panels',
  4: 'first click locks the pointer and starts audio, with no new page elements',
  5: 'the mouse wheel changes nothing',
  6: 'ctrl+wheel changes nothing',
  7: 'trackpad pinch and the + - = _ keys change nothing',
  8: 'WASD and arrow keys walk at 1.2-1.9 m/s relative to the camera',
  9: 'Shift makes the wade 1.2-1.4 times faster',
  10: 'C cycles the three camera presets',
  11: 'pointer-locked mouse orbit: full 360 degree yaw, pitch held to -30..+60 degrees',
  12: 'camera eases back behind the astronaut while walking',
  13: 'no jump, dodge, roll or interact keys',
  14: 'brace locks input and the scripted camera; the preset comes back afterwards',
  15: 'releasing the pointer clears held keys',
  16: 'without WebGPU, one plain line names the supported browsers',
  17: 'the console stays clean',
};
const CHECK_PHASES = { 1: 2, 2: 6, 3: 6, 4: 2, 5: 2, 6: 2, 7: 2, 8: 5, 9: 5, 10: 5, 11: 5, 12: 5, 13: 5, 14: 7, 15: 2, 16: 6, 17: 2 };
const NOT_WRITTEN_YET = new Set([]);
const WHEEL_EVENT_GAP_MS = 16;
const SETTLE_AFTER_BLOCK_MS = 200;
const DISTANCE_TOLERANCE_METRES = 1e-3;
const ANGLE_TOLERANCE_DEGREES = 0.5;

const WHEEL_RECORDER_SOURCE = `
window.harnessWheelLog = [];
window.addEventListener('wheel', (event) => {
  setTimeout(() => window.harnessWheelLog.push({
    ctrlKey: event.ctrlKey,
    deltaX: event.deltaX,
    deltaY: event.deltaY,
    cancelable: event.cancelable,
    defaultPrevented: event.defaultPrevented,
  }), 0);
}, { capture: true, passive: true });
`;
const NO_WEBGPU_SOURCE = "Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined });";

const results = [];
function record(number, passed, detail) {
  const status = passed ? 'PASS' : 'FAIL';
  results.push({ number, status, detail });
  console.log(`${status}  ${number}. ${CHECK_TITLES[number]}${detail ? `\n      ${detail}` : ''}`);
}

const shouldRun = (number) => CHECK_PHASES[number] <= phase;

async function readViewState(page) {
  return page.evaluate(pageExpression(`(() => {
    const stats = window.millersPlanet.stats();
    return {
      camera: stats.camera || null,
      pointerLocked: stats.pointerLocked ?? null,
      pointerLockElementIsCanvas: document.pointerLockElement !== null && document.pointerLockElement === document.querySelector('canvas'),
      audioState: stats.audio ? stats.audio.state : null,
      visualViewportScale: window.visualViewport ? window.visualViewport.scale : null,
      devicePixelRatio: window.devicePixelRatio,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      wheelEventsLogged: window.harnessWheelLog.length,
    };
  })()`));
}

function describeViewChanges(before, after, expectedDevicePixelRatio) {
  const problems = [];
  if (!before.camera || !after.camera) return ['stats().camera is missing, so the camera cannot be compared'];
  const numberChanged = (name, tolerance) => {
    const first = before.camera[name];
    const second = after.camera[name];
    if (typeof first !== 'number' || typeof second !== 'number') return first !== second;
    return Math.abs(second - first) > tolerance;
  };
  if (numberChanged('distance', DISTANCE_TOLERANCE_METRES)) problems.push(`camera distance ${before.camera.distance} -> ${after.camera.distance}`);
  if (numberChanged('fovDegrees', 1e-6)) problems.push(`field of view ${before.camera.fovDegrees} -> ${after.camera.fovDegrees} degrees`);
  if (numberChanged('yawDegrees', ANGLE_TOLERANCE_DEGREES)) problems.push(`yaw ${before.camera.yawDegrees} -> ${after.camera.yawDegrees} degrees`);
  if (numberChanged('pitchDegrees', ANGLE_TOLERANCE_DEGREES)) problems.push(`pitch ${before.camera.pitchDegrees} -> ${after.camera.pitchDegrees} degrees`);
  if (before.camera.preset !== after.camera.preset) problems.push(`preset ${before.camera.preset} -> ${after.camera.preset}`);
  if (before.camera.mode !== after.camera.mode) problems.push(`camera mode ${before.camera.mode} -> ${after.camera.mode}`);
  if (after.visualViewportScale !== 1) problems.push(`visualViewport.scale is ${after.visualViewportScale}`);
  if (after.devicePixelRatio !== expectedDevicePixelRatio) problems.push(`devicePixelRatio is ${after.devicePixelRatio}`);
  if (after.scrollX !== 0 || after.scrollY !== 0) problems.push(`the page scrolled to ${after.scrollX}, ${after.scrollY}`);
  return problems;
}

async function canvasCentre(page) {
  return page.evaluate(`(() => {
    const canvas = document.querySelector('canvas');
    if (!canvas) return null;
    const box = canvas.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  })()`);
}

async function wheelBlock(page, centre, { label, count, deltaX = 0, deltaY = 0, modifiers = 0, gapMs = WHEEL_EVENT_GAP_MS }, expectedDevicePixelRatio) {
  const before = await readViewState(page);
  for (let eventIndex = 0; eventIndex < count; eventIndex++) {
    await page.wheel({ x: centre.x, y: centre.y, deltaX, deltaY, modifiers });
    if (gapMs) await sleep(gapMs);
  }
  await sleep(SETTLE_AFTER_BLOCK_MS);
  const after = await readViewState(page);
  const blockLog = await page.evaluate(`window.harnessWheelLog.slice(${before.wheelEventsLogged})`);
  const problems = describeViewChanges(before, after, expectedDevicePixelRatio);
  if (blockLog.length !== count) problems.push(`${count} wheel events were sent but the page saw ${blockLog.length}`);
  const notPrevented = blockLog.filter((entry) => !entry.defaultPrevented).length;
  if (notPrevented) problems.push(`${notPrevented} of ${blockLog.length} wheel events were not preventDefault()ed, so the browser could scroll or zoom`);
  return { label, problems, after };
}

async function keyBlock(page, { label, code, modifiers = [], presses = 5 }, expectedDevicePixelRatio) {
  const before = await readViewState(page);
  for (let press = 0; press < presses; press++) await page.keyPress(code, { modifiers, holdMs: 30, afterMs: 30 });
  await sleep(SETTLE_AFTER_BLOCK_MS);
  const after = await readViewState(page);
  return { label, problems: describeViewChanges(before, after, expectedDevicePixelRatio), after };
}

async function readPlayer(page) {
  return page.evaluate(pageExpression(`(() => {
    const stats = window.millersPlanet.stats();
    return {
      position: stats.astronaut.position,
      headingDegrees: stats.astronaut.headingDegrees,
      preset: stats.camera.preset,
      distance: stats.camera.distance,
      rigYawDegrees: stats.camera.rigYawDegrees,
      rigPitchDegrees: stats.camera.rigPitchDegrees,
      helmetRimVisible: stats.helmetRimVisible,
      mode: stats.camera.mode,
      timeMs: performance.now(),
    };
  })()`));
}

const wrapDegrees = (value) => ((((value + 180) % 360) + 360) % 360) - 180;

function horizontalMove(from, to) {
  const deltaX = to.position[0] - from.position[0];
  const deltaZ = to.position[2] - from.position[2];
  return {
    distance: Math.hypot(deltaX, deltaZ),
    seconds: (to.timeMs - from.timeMs) / 1000,
    directionDegrees: (Math.atan2(deltaX, deltaZ) * 180) / Math.PI,
  };
}

async function steadySpeed(page, codes, modifiers = []) {
  for (const code of codes) await page.keyDown(code, { modifiers });
  await sleep(1500);
  const first = await readPlayer(page);
  await sleep(1500);
  const second = await readPlayer(page);
  for (const code of [...codes].reverse()) await page.keyUp(code, { modifiers });
  await sleep(1300);
  const move = horizontalMove(first, second);
  return { speed: move.distance / move.seconds, directionErrorDegrees: Math.abs(wrapDegrees(move.directionDegrees - second.rigYawDegrees)) };
}

async function ensurePointerLocked(page, centre) {
  const locked = await page.evaluate("document.pointerLockElement !== null && document.pointerLockElement === document.querySelector('canvas')");
  if (locked) return true;
  await page.click(centre.x, centre.y);
  await sleep(300);
  return page.evaluate("document.pointerLockElement !== null && document.pointerLockElement === document.querySelector('canvas')");
}

async function releasePointerLock(page) {
  await page.evaluate('document.exitPointerLock()');
  await sleep(250);
}

async function runBlocksInBothLockStates(page, centre, blocks, expectedDevicePixelRatio, runBlock) {
  const outcomes = [];
  for (const lockState of ['locked', 'unlocked']) {
    if (lockState === 'locked') {
      if (!(await ensurePointerLocked(page, centre))) {
        outcomes.push({ label: 'locking the pointer for the locked pass', problems: ['a click on the canvas did not lock the pointer'] });
        continue;
      }
    } else {
      await releasePointerLock(page);
    }
    for (const block of blocks) {
      const outcome = await runBlock(block);
      if (lockState === 'locked' && !outcome.after?.pointerLockElementIsCanvas) outcome.problems.push('the pointer lock was lost during this block, so the locked case was not really tested');
      outcomes.push({ ...outcome, label: `${outcome.label} (${lockState})` });
    }
  }
  return outcomes;
}

function summariseBlocks(number, outcomes, baseline, finalState, expectedDevicePixelRatio) {
  const failedBlocks = outcomes.filter((outcome) => outcome.problems.length);
  const netChanges = finalState ? describeViewChanges(baseline, finalState, expectedDevicePixelRatio) : [];
  const netNote = netChanges.length ? `net change after all blocks: ${netChanges.join('; ')}` : 'net change after all blocks: none';
  if (!failedBlocks.length) {
    record(number, true, `${outcomes.length} one-direction blocks, state checked after each; every wheel event was preventDefault()ed; ${netNote}`);
    return;
  }
  record(number, false, `${failedBlocks.map((outcome) => `${outcome.label}: ${outcome.problems.join('; ')}`).join('\n      ')}\n      (${netNote})`);
}

async function heldKeysExpression(page) {
  return page.evaluate(pageExpression(`(() => {
    const stats = window.millersPlanet.stats();
    const candidates = [stats.input && stats.input.heldKeys, stats.heldKeys, stats.input && stats.input.keysDown];
    const found = candidates.find((value) => Array.isArray(value) || (value && typeof value[Symbol.iterator] === 'function'));
    return found === undefined ? null : Array.from(found);
  })()`));
}

async function checkNoWebGpuPage(server, viewport) {
  const target = await openMillersPlanet({ server, viewport, scriptsBeforeLoad: [NO_WEBGPU_SOURCE], waitUntilReady: false });
  try {
    const { page } = target;
    await page.evaluate('window.millersPlanet && window.millersPlanet.ready ? Promise.race([Promise.resolve(window.millersPlanet.ready).catch(() => null), new Promise((resolve) => setTimeout(resolve, 5000))]) : null');
    await sleep(300);
    const screen = await page.evaluate(`(() => {
      const visible = [];
      for (const element of document.body.querySelectorAll('*')) {
        if (['SCRIPT', 'STYLE', 'LINK', 'META'].includes(element.tagName)) continue;
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0 || box.width === 0 || box.height === 0) continue;
        visible.push({ tag: element.tagName.toLowerCase(), id: element.id, text: (element.innerText || '').trim() });
      }
      return { visible, bodyText: document.body.innerText.trim() };
    })()`);
    const filePath = path.join(evidenceDirectory(), `${phase}-no-webgpu.png`);
    mkdirSync(path.dirname(filePath), { recursive: true });
    await page.screenshot(filePath);
    const lines = screen.bodyText.split('\n').map((line) => line.trim()).filter(Boolean);
    const problems = [];
    if (lines.length !== 1) problems.push(`expected exactly one line of text, found ${lines.length}: ${JSON.stringify(lines)}`);
    if (!/Chrome/.test(screen.bodyText)) problems.push('the line does not name Chrome');
    const visibleCanvas = screen.visible.filter((entry) => entry.tag === 'canvas');
    if (visibleCanvas.length) problems.push('the canvas is still visible');
    const textElements = screen.visible.filter((entry) => entry.text);
    if (textElements.length !== 1) problems.push(`expected one visible text element, found ${textElements.length}`);
    record(16, problems.length === 0, `${problems.length ? problems.join('; ') : `"${lines[0]}"`} (screenshot ${filePath})`);
  } finally {
    await target.close();
  }
}

const server = await startMillersPlanetServer();
for (const warning of server.warnings) console.warn(`WARNING: ${warning}`);
let exitCode = 0;
try {
  const target = await openMillersPlanet({ server, query: { scale: 0.5 }, scriptsBeforeLoad: [WHEEL_RECORDER_SOURCE] });
  try {
    const { page, viewport } = target;
    const expectedDevicePixelRatio = viewport.deviceScaleFactor;
    const expectedCanvas = [Math.round(viewport.width * viewport.deviceScaleFactor), Math.round(viewport.height * viewport.deviceScaleFactor)];
    console.log(`Interaction checks for phase ${phase} on ${server.description} (window ${viewport.width}x${viewport.height} at ${viewport.deviceScaleFactor}x)\n`);

    if (shouldRun(1)) {
      const startUp = await page.evaluate(pageExpression(`(() => {
        const canvas = document.querySelector('canvas');
        const stats = window.millersPlanet.stats();
        return { isReady: window.millersPlanet.isReady, canvas: canvas ? [canvas.width, canvas.height] : null, output: stats.output || null };
      })()`));
      const errorsSoFar = page.pageErrors();
      const problems = [];
      if (startUp.isReady !== true) problems.push('millersPlanet.isReady is not true');
      if (!startUp.canvas || startUp.canvas[0] !== expectedCanvas[0] || startUp.canvas[1] !== expectedCanvas[1]) problems.push(`canvas is ${JSON.stringify(startUp.canvas)}, expected ${expectedCanvas.join('x')}`);
      if (!startUp.output || startUp.output[0] !== expectedCanvas[0] || startUp.output[1] !== expectedCanvas[1]) problems.push(`stats().output is ${JSON.stringify(startUp.output)}, expected ${expectedCanvas.join('x')}`);
      if (errorsSoFar.length) problems.push(`console errors at start-up: ${errorsSoFar.map((event) => event.text).join(' | ')}`);
      record(1, problems.length === 0, problems.length ? problems.join('; ') : `ready, canvas ${startUp.canvas.join('x')}, stats().output ${startUp.output.join('x')}, no console errors`);
    }

    const centre = await canvasCentre(page);
    if (!centre) throw new Error('the page has no canvas to click');
    await page.mouseMove(centre.x, centre.y);
    await sleep(200);

    if (shouldRun(2)) {
      const opening = await page.evaluate(pageExpression(`(() => {
        const stats = window.millersPlanet.stats();
        return { preset: stats.camera.preset, mode: stats.camera.mode, rigYawDegrees: stats.camera.rigYawDegrees, headingDegrees: stats.astronaut.headingDegrees, ship: stats.ship, pointerLocked: stats.pointerLocked, audioState: stats.audio.state };
      })()`));
      const problems = [];
      if (opening.preset !== 0) problems.push(`preset ${opening.preset} (expected 0)`);
      if (opening.mode !== 'player') problems.push(`camera mode ${opening.mode} (expected player, no cutscene)`);
      const behindError = Math.abs(((opening.rigYawDegrees - opening.headingDegrees + 540) % 360) - 180);
      if (behindError > 15) problems.push(`camera yaw ${behindError.toFixed(1)} degrees off the astronaut's heading (expected behind, within 15)`);
      if (opening.ship.state !== 0 || !opening.ship.visible) problems.push(`ship state ${opening.ship.state}, visible ${opening.ship.visible} (expected the intact ship)`);
      if (opening.ship.distanceFromAstronautMetres < 15 || opening.ship.distanceFromAstronautMetres > 25) problems.push(`ship ${opening.ship.distanceFromAstronautMetres.toFixed(1)} m away (expected 15-25)`);
      if (opening.pointerLocked) problems.push('the pointer is locked before any click');
      if (opening.audioState === 'running') problems.push('audio is running before any click');
      record(2, problems.length === 0, problems.length ? problems.join('; ') : `preset 0, player camera ${behindError.toFixed(1)} degrees off the heading, intact ship ${opening.ship.distanceFromAstronautMetres.toFixed(1)} m away, pointer free, audio ${opening.audioState}`);
    }

    if (shouldRun(3)) {
      const problems = [];
      const screen = await page.evaluate(`(() => {
        const canvas = document.querySelector('canvas');
        const panel = document.getElementById('clocks');
        const hudRow = document.getElementById('hud');
        const countdown = document.getElementById('wave-countdown');
        const visible = [...document.body.querySelectorAll('*')].filter((element) => {
          const style = getComputedStyle(element);
          const box = element.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0 && box.width > 0 && box.height > 0;
        });
        const strays = visible.filter((element) => element !== canvas && !(hudRow && (element === hudRow || hudRow.contains(element)))).map((element) => element.tagName + (element.id ? '#' + element.id : ''));
        const box = panel ? panel.getBoundingClientRect() : null;
        const style = panel ? getComputedStyle(panel) : null;
        return {
          strays,
          hasPanel: Boolean(panel),
          countdownRightOfClocks: Boolean(panel && countdown && countdown.getBoundingClientRect().left >= panel.getBoundingClientRect().right && Math.abs(countdown.getBoundingClientRect().top - panel.getBoundingClientRect().top) < 2),
          countdownBackdropFilter: countdown ? (getComputedStyle(countdown).backdropFilter || 'none') : 'none',
          leftFraction: box ? box.left / innerWidth : null,
          topFraction: box ? box.top / innerHeight : null,
          backdropFilter: style ? (style.backdropFilter || style.webkitBackdropFilter || 'none') : 'none',
          fontFamily: style ? style.fontFamily : null,
        };
      })()`);
      if (!screen.hasPanel) problems.push('no clock panel (#clocks) on the page');
      if (screen.strays.length) problems.push(`other visible elements: ${screen.strays.join(', ')}`);
      if (screen.hasPanel && (screen.leftFraction >= 0.1 || screen.topFraction >= 0.1)) problems.push(`panel at ${(screen.leftFraction * 100).toFixed(1)}% / ${(screen.topFraction * 100).toFixed(1)}% of the viewport (expected the top-left corner)`);
      if (screen.backdropFilter === 'none') problems.push('the panel has no backdrop-filter (expected glass)');
      if (!screen.countdownRightOfClocks) problems.push('no wave countdown panel (#wave-countdown) level with the clocks on their right');
      if (screen.countdownBackdropFilter !== screen.backdropFilter) problems.push(`the countdown panel's glass (${screen.countdownBackdropFilter}) differs from the clocks' (${screen.backdropFilter})`);
      const skip = await page.evaluate(pageExpression(`(async () => {
        const api = window.millersPlanet;
        const results = [];
        for (const seconds of [3600, 1200, 754.6]) {
          api.freezeTime(seconds);
          await new Promise((resolve) => setTimeout(resolve, 120));
          const clocks = api.stats().clocks;
          const panel = document.getElementById('clocks');
          results.push({ seconds, ratio: clocks.earthSeconds / clocks.millerSeconds, millerText: clocks.panelMillerText, earthText: clocks.panelEarthText, waveText: clocks.panelWaveText, countdownText: clocks.panelCountdownText, panelText: panel ? panel.textContent : '' });
        }
        api.freezeTime(0);
        api.freezeTime(null);
        return results;
      })()`));
      const expected = { 3600: ['01:00:00', '7 yr 0 d 00:00', '15', 'now'], 1200: ['00:20:00', '2 yr 121 d 18:00', '5', 'now'], 754.6: ['00:12:34', '1 yr 170 d 16:09', '4', '03:26'] };
      for (const entry of skip) {
        if (Math.abs(entry.ratio - 61362) > 1e-6) problems.push(`Earth/Miller ratio ${entry.ratio} at ${entry.seconds} s (expected 61362)`);
        const [millerExpected, earthExpected, waveExpected, countdownExpected] = expected[entry.seconds];
        if (entry.waveText !== waveExpected || entry.countdownText !== countdownExpected) problems.push(`at ${entry.seconds} s the countdown shows wave ${entry.waveText}, impact in ${entry.countdownText} (expected wave ${waveExpected}, ${countdownExpected})`);
        if (entry.millerText !== millerExpected || entry.earthText !== earthExpected) problems.push(`at ${entry.seconds} s the panel shows ${entry.millerText} / ${entry.earthText} (expected ${millerExpected} / ${earthExpected})`);
      }
      record(3, problems.length === 0, problems.length ? problems.join('; ') : `only the canvas and the clock panel are visible; panel at ${(screen.leftFraction * 100).toFixed(1)}% / ${(screen.topFraction * 100).toFixed(1)}% with backdrop-filter "${screen.backdropFilter}"; time skips 3600 / 1200 / 754.6 s show ${skip.map((entry) => entry.millerText + ' | ' + entry.earthText + ' | wave ' + entry.waveText + ' in ' + entry.countdownText).join(', ')} (ratio 61362)`);
    }

    if (shouldRun(4)) {
      const before = await page.evaluate(`({ elementCount: document.querySelectorAll('*').length, signature: [...document.querySelectorAll('*')].map((element) => element.tagName + '#' + element.id).join(',') })`);
      const stateBefore = await readViewState(page);
      await page.click(centre.x, centre.y);
      let state = stateBefore;
      for (let attempt = 0; attempt < 20; attempt++) {
        await sleep(100);
        state = await readViewState(page);
        if (state.pointerLockElementIsCanvas && state.audioState === 'running') break;
      }
      const after = await page.evaluate(`({ elementCount: document.querySelectorAll('*').length, signature: [...document.querySelectorAll('*')].map((element) => element.tagName + '#' + element.id).join(',') })`);
      const problems = [];
      if (stateBefore.pointerLockElementIsCanvas) problems.push('the pointer was already locked before the click');
      if (stateBefore.audioState === 'running') problems.push('audio was already running before the click');
      if (!state.pointerLockElementIsCanvas) problems.push('document.pointerLockElement is not the canvas after the click');
      if (state.pointerLocked !== true) problems.push(`stats().pointerLocked is ${JSON.stringify(state.pointerLocked)}`);
      if (state.audioState !== 'running') problems.push(`stats().audio.state is ${JSON.stringify(state.audioState)}, expected "running"`);
      if (after.elementCount !== before.elementCount || after.signature !== before.signature) problems.push(`the page gained or changed elements (${before.elementCount} -> ${after.elementCount})`);
      record(4, problems.length === 0, problems.length ? problems.join('; ') : `pointer locked to the canvas, audio running, still ${after.elementCount} elements`);
    }

    const zoomBaseline = await readViewState(page);
    if (shouldRun(5)) {
      const blocks = [
        { label: '10 wheel steps down', count: 10, deltaY: 120 },
        { label: '10 wheel steps up', count: 10, deltaY: -120 },
        { label: '10 wheel steps right', count: 10, deltaX: 120 },
        { label: '10 wheel steps left', count: 10, deltaX: -120 },
      ];
      const outcomes = await runBlocksInBothLockStates(page, centre, blocks, expectedDevicePixelRatio, (block) => wheelBlock(page, centre, block, expectedDevicePixelRatio));
      summariseBlocks(5, outcomes, zoomBaseline, await readViewState(page), expectedDevicePixelRatio);
    }
    if (shouldRun(6)) {
      const blocks = [
        { label: '10 ctrl+wheel steps down (zoom out)', count: 10, deltaY: 120, modifiers: ['Control'] },
        { label: '10 ctrl+wheel steps up (zoom in)', count: 10, deltaY: -120, modifiers: ['Control'] },
      ];
      const outcomes = await runBlocksInBothLockStates(page, centre, blocks, expectedDevicePixelRatio, (block) => wheelBlock(page, centre, block, expectedDevicePixelRatio));
      summariseBlocks(6, outcomes, zoomBaseline, await readViewState(page), expectedDevicePixelRatio);
    }
    if (shouldRun(7)) {
      const pinchBlocks = [
        { label: 'pinch out: 40 small ctrl+wheel steps', count: 40, deltaY: -4, modifiers: ['Control'] },
        { label: 'pinch in: 40 small ctrl+wheel steps', count: 40, deltaY: 4, modifiers: ['Control'] },
      ];
      const keyBlocks = [
        { label: '"+" key x5', code: 'Equal', modifiers: ['Shift'] },
        { label: '"=" key x5', code: 'Equal' },
        { label: '"-" key x5', code: 'Minus' },
        { label: '"_" key x5', code: 'Minus', modifiers: ['Shift'] },
        { label: 'keypad "+" x5', code: 'NumpadAdd' },
        { label: 'keypad "-" x5', code: 'NumpadSubtract' },
      ];
      const outcomes = await runBlocksInBothLockStates(page, centre, [...pinchBlocks, ...keyBlocks], expectedDevicePixelRatio, (block) => (block.code ? keyBlock(page, block, expectedDevicePixelRatio) : wheelBlock(page, centre, block, expectedDevicePixelRatio)));
      summariseBlocks(7, outcomes, zoomBaseline, await readViewState(page), expectedDevicePixelRatio);
    }

    let plainWalkSpeed = null;
    if (shouldRun(8)) {
      const problems = [];
      const walk = await steadySpeed(page, ['KeyW']);
      plainWalkSpeed = walk.speed;
      if (walk.speed < 1.2 || walk.speed > 1.9) problems.push(`holding W walks at ${walk.speed.toFixed(3)} m/s (expected 1.2-1.9)`);
      if (walk.directionErrorDegrees > 20) problems.push(`W walks ${walk.directionErrorDegrees.toFixed(1)} degrees away from the camera's forward direction`);
      const arrow = await steadySpeed(page, ['ArrowUp']);
      if (Math.abs(arrow.speed - walk.speed) > 0.05 || arrow.directionErrorDegrees > 20) problems.push(`ArrowUp walks at ${arrow.speed.toFixed(3)} m/s, ${arrow.directionErrorDegrees.toFixed(1)} degrees off forward (W: ${walk.speed.toFixed(3)} m/s)`);
      const sideResults = [];
      for (const [code, offsetDegrees] of [['KeyS', 180], ['KeyA', -90], ['KeyD', 90], ['ArrowLeft', -90]]) {
        await page.keyDown(code);
        await sleep(1700);
        const start = await readPlayer(page);
        await sleep(900);
        const end = await readPlayer(page);
        await page.keyUp(code);
        await sleep(1300);
        const move = horizontalMove(start, end);
        const errorDegrees = Math.abs(wrapDegrees(move.directionDegrees - (end.rigYawDegrees + offsetDegrees)));
        sideResults.push(`${code} ${move.distance.toFixed(2)} m at ${errorDegrees.toFixed(1)} degrees off`);
        if (move.distance < 0.15 || errorDegrees > 35) problems.push(`${code} moved ${move.distance.toFixed(3)} m, ${errorDegrees.toFixed(1)} degrees away from the camera-relative direction`);
      }
      record(8, problems.length === 0, problems.length ? problems.join('; ') : `W ${walk.speed.toFixed(3)} m/s, ${walk.directionErrorDegrees.toFixed(1)} degrees off forward; ArrowUp ${arrow.speed.toFixed(3)} m/s; over the last 0.9 s of each 2.6 s hold: ${sideResults.join(', ')}`);
    }

    if (shouldRun(9)) {
      const problems = [];
      const baseline = plainWalkSpeed ?? (await steadySpeed(page, ['KeyW'])).speed;
      const shift = await steadySpeed(page, ['ShiftLeft', 'KeyW'], ['Shift']);
      const ratio = shift.speed / baseline;
      if (ratio < 1.2 || ratio > 1.4) problems.push(`Shift+W ${shift.speed.toFixed(3)} m/s is ${ratio.toFixed(3)} times plain W ${baseline.toFixed(3)} m/s (expected 1.2-1.4)`);
      record(9, problems.length === 0, problems.length ? problems.join('; ') : `Shift+W ${shift.speed.toFixed(3)} m/s against W ${baseline.toFixed(3)} m/s: ratio ${ratio.toFixed(3)}`);
    }

    if (shouldRun(10)) {
      const problems = [];
      const states = [await readPlayer(page)];
      for (let press = 0; press < 3; press++) {
        await page.keyPress('KeyC', { holdMs: 40, afterMs: 40 });
        await sleep(1100);
        states.push(await readPlayer(page));
      }
      const presets = states.map((state) => state.preset);
      if (presets.join(',') !== '0,1,2,0') problems.push(`presets went ${presets.join(' -> ')} (expected 0 -> 1 -> 2 -> 0)`);
      const distances = states.map((state) => state.distance);
      if (!(distances[0] > distances[1] && distances[1] > distances[2])) problems.push(`camera distances ${distances.slice(0, 3).map((value) => value.toFixed(3)).join(' -> ')} do not strictly decrease`);
      const rims = states.map((state) => state.helmetRimVisible);
      if (rims.join(',') !== 'false,false,true,false') problems.push(`helmet rim visible ${rims.join(' -> ')} (expected only in preset 2)`);
      record(10, problems.length === 0, problems.length ? problems.join('; ') : `presets ${presets.join(' -> ')}, distances ${distances.map((value) => value.toFixed(2)).join(' -> ')} m, helmet rim only in first person`);
    }

    let orbitDetail = null;
    if (shouldRun(11)) {
      const problems = [];
      if (!(await ensurePointerLocked(page, centre))) {
        problems.push('could not lock the pointer');
      } else {
        let previous = await readPlayer(page);
        let totalYaw = 0;
        let firstStep = null;
        for (let move = 0; move < 14 && totalYaw < 380; move++) {
          await page.mouseMoveBy(600, 0, { steps: 6 });
          await sleep(150);
          const current = await readPlayer(page);
          const step = wrapDegrees(current.rigYawDegrees - previous.rigYawDegrees);
          if (firstStep === null) firstStep = step;
          totalYaw += step;
          previous = current;
        }
        if (!(firstStep > 0)) problems.push(`moving the mouse right turned the camera by ${firstStep} degrees (expected a positive yaw turn to the right)`);
        if (totalYaw < 360) problems.push(`yaw only turned ${totalYaw.toFixed(1)} degrees in total`);
        await page.mouseMoveBy(0, -5000, { steps: 10 });
        await sleep(200);
        const up = await readPlayer(page);
        await page.mouseMoveBy(0, 5000, { steps: 10 });
        await sleep(200);
        const down = await readPlayer(page);
        if (Math.abs(up.rigPitchDegrees - 60) > ANGLE_TOLERANCE_DEGREES) problems.push(`pitch saturated at ${up.rigPitchDegrees.toFixed(2)} degrees looking up (expected +60)`);
        if (Math.abs(down.rigPitchDegrees + 30) > ANGLE_TOLERANCE_DEGREES) problems.push(`pitch saturated at ${down.rigPitchDegrees.toFixed(2)} degrees looking down (expected -30)`);
        await page.mouseMoveBy(0, -Math.round(((32.7 * Math.PI) / 180) / 0.0016), { steps: 4 });
        await sleep(200);
        orbitDetail = `yaw turned ${totalYaw.toFixed(1)} degrees without clamping (first step ${firstStep.toFixed(1)}), pitch limits ${up.rigPitchDegrees.toFixed(2)} / ${down.rigPitchDegrees.toFixed(2)} degrees`;
      }
      record(11, problems.length === 0, problems.length ? problems.join('; ') : orbitDetail);
    }

    if (shouldRun(12)) {
      const problems = [];
      if (!(await ensurePointerLocked(page, centre))) {
        problems.push('could not lock the pointer');
      } else {
        const before = await readPlayer(page);
        const turnDegrees = wrapDegrees(before.headingDegrees + 120 - before.rigYawDegrees);
        await page.mouseMoveBy(Math.round(((turnDegrees * Math.PI) / 180) / 0.0018), 0, { steps: 6 });
        await sleep(300);
        const offset = await readPlayer(page);
        await page.keyDown('KeyW');
        await sleep(3000);
        const after = await readPlayer(page);
        await page.keyUp('KeyW');
        await sleep(1300);
        const startError = Math.abs(wrapDegrees(offset.rigYawDegrees - offset.headingDegrees));
        const endError = Math.abs(wrapDegrees(after.rigYawDegrees - after.headingDegrees));
        if (startError < 100) problems.push(`the camera was only ${startError.toFixed(1)} degrees off the heading before walking`);
        if (endError >= 20) problems.push(`after 3 s of W the camera is ${endError.toFixed(1)} degrees off the heading (limit 20)`);
        if (!problems.length) record(12, true, `camera ${startError.toFixed(1)} degrees off the heading before walking, ${endError.toFixed(1)} degrees after 3 s of W`);
      }
      if (problems.length) record(12, false, problems.join('; '));
    }

    if (shouldRun(13)) {
      const problems = [];
      const before = await readPlayer(page);
      for (const code of ['Space', 'KeyE', 'KeyF', 'KeyQ', 'ControlLeft', 'KeyR', 'KeyV']) await page.keyPress(code, { holdMs: 60, afterMs: 60 });
      await page.click(centre.x, centre.y, { button: 'right' });
      await sleep(600);
      const after = await readPlayer(page);
      const moved = horizontalMove(before, after).distance;
      if (moved > 0.01) problems.push(`the astronaut moved ${moved.toFixed(3)} m`);
      if (Math.abs(wrapDegrees(after.headingDegrees - before.headingDegrees)) > 1) problems.push(`the heading changed by ${wrapDegrees(after.headingDegrees - before.headingDegrees).toFixed(2)} degrees`);
      if (after.preset !== before.preset) problems.push(`the preset changed ${before.preset} -> ${after.preset}`);
      if (Math.abs(after.distance - before.distance) > DISTANCE_TOLERANCE_METRES) problems.push(`the camera distance changed ${before.distance} -> ${after.distance}`);
      if (after.mode !== before.mode) problems.push(`the camera mode changed ${before.mode} -> ${after.mode}`);
      record(13, problems.length === 0, problems.length ? problems.join('; ') : 'Space, E, F, Q, R, V, Ctrl and a right-click left the astronaut and the camera unchanged');
    }

    if (shouldRun(14)) {
      const problems = [];
      const readWave = () => page.evaluate(pageExpression(`(() => {
        const stats = window.millersPlanet.stats();
        return { preset: stats.camera.preset, scripted: stats.camera.scriptedWeight, locked: stats.astronaut.inputLocked, braced: stats.astronaut.braced, position: stats.astronaut.position, phase: stats.wave.phase, index: stats.wave.index };
      })()`));
      let start = await readWave();
      for (let presses = 0; presses < 3 && start.preset !== 1; presses++) {
        await page.keyPress('KeyC', { holdMs: 40, afterMs: 900 });
        start = await readWave();
      }
      if (start.preset !== 1) problems.push(`could not select preset 1 with C (preset ${start.preset})`);
      await page.evaluate(pageExpression(`window.millersPlanet.skipTo({ waveIndex: 1, phase: 'b', secondsIntoPhase: 0.2 })`));
      await sleep(1700);
      const braced = await readWave();
      if (braced.phase !== 'brace') problems.push(`skipTo landed in phase ${braced.phase}, not brace`);
      if (!braced.locked) problems.push('input is not locked during the brace');
      if (!braced.braced) problems.push('the astronaut is not braced 1.5 s into the brace');
      if (braced.scripted < 0.9) problems.push(`the scripted camera weight is ${braced.scripted.toFixed(2)} 1.5 s into the brace (expected near 1)`);
      await page.keyDown('KeyW');
      await sleep(800);
      await page.keyUp('KeyW');
      const afterPush = await readWave();
      const pushed = horizontalMove(braced, afterPush).distance;
      if (pushed > 0.01) problems.push(`W moved the braced astronaut ${pushed.toFixed(3)} m`);
      await page.evaluate(pageExpression(`window.millersPlanet.skipTo({ waveIndex: 1, phase: 'd', secondsIntoPhase: 5.7 })`));
      await sleep(1300);
      const after = await readWave();
      if (after.locked) problems.push(`input is still locked after the drain (phase ${after.phase})`);
      if (after.scripted > 0.001) problems.push(`the scripted camera is still blended in after the drain (weight ${after.scripted.toFixed(3)})`);
      if (after.preset !== 1) problems.push(`the preset after the wave is ${after.preset}, not the player's 1`);
      if (after.braced) problems.push('the astronaut is still braced after the drain');
      await page.keyDown('KeyW');
      await sleep(1200);
      await page.keyUp('KeyW');
      const walked = horizontalMove(after, await readWave()).distance;
      if (walked < 0.3) problems.push(`W moved the astronaut only ${walked.toFixed(2)} m after the wave`);
      await page.evaluate(pageExpression(`window.millersPlanet.skipTo({ waveIndex: 2, phase: 'calm', secondsIntoPhase: 1 })`));
      for (let presses = 0; presses < 3; presses++) {
        const state = await readWave();
        if (state.preset === 0) break;
        await page.keyPress('KeyC', { holdMs: 40, afterMs: 900 });
      }
      record(14, problems.length === 0, problems.length ? problems.join('; ') : `brace: input locked, braced, scripted camera weight ${braced.scripted.toFixed(2)}, W moved ${pushed.toFixed(3)} m; after the drain: unlocked, scripted weight ${after.scripted.toFixed(3)}, preset ${after.preset} restored, W walked ${walked.toFixed(2)} m`);
    }

    if (shouldRun(15)) {
      const problems = [];
      if (!(await ensurePointerLocked(page, centre))) {
        problems.push('could not lock the pointer, so the release could not be tested');
      } else {
        await page.keyDown('ShiftLeft', { modifiers: ['Shift'] });
        await page.keyDown('KeyW', { modifiers: ['Shift'] });
        await sleep(150);
        const heldWhileLocked = await heldKeysExpression(page);
        if (heldWhileLocked === null) {
          problems.push('the page does not report held keys (expected stats().input.heldKeys as a list of KeyboardEvent.code values), so the release cannot be verified');
        } else if (!heldWhileLocked.includes('KeyW')) {
          problems.push(`while W was held the page reported held keys ${JSON.stringify(heldWhileLocked)}, so the observation does not work`);
        } else {
          await releasePointerLock(page);
          const heldAfterRelease = await heldKeysExpression(page);
          const lockAfterRelease = await readViewState(page);
          if (lockAfterRelease.pointerLockElementIsCanvas) problems.push('document.exitPointerLock() did not release the pointer');
          if (heldAfterRelease.length) problems.push(`keys still held after the pointer was released: ${JSON.stringify(heldAfterRelease)}`);
          if (!problems.length) record(15, true, `held ${JSON.stringify(heldWhileLocked)} while locked; none after document.exitPointerLock(). (Esc itself cannot be tested headless: Esc sent over CDP does not release the lock.)`);
        }
        await page.keyUp('KeyW', { modifiers: ['Shift'] });
        await page.keyUp('ShiftLeft');
      }
      if (problems.length) record(15, false, problems.join('; '));
    }

    if (shouldRun(17)) {
      const errors = page.pageErrors();
      const warnings = page.pageWarnings();
      record(17, errors.length === 0, errors.length ? errors.map((event) => `[${event.kind}] ${event.text}`).join('\n      ') : `no errors${warnings.length ? ` (${warnings.length} warning(s): ${warnings.slice(0, 3).map((event) => event.text).join(' | ')})` : ''}`);
    }
  } finally {
    await target.close();
  }
  if (shouldRun(16)) await checkNoWebGpuPage(server, undefined);
} catch (error) {
  console.error(`\nThe interaction run stopped early: ${error.message}`);
  exitCode = 1;
} finally {
  await server.close();
}

const failed = results.filter((result) => result.status === 'FAIL');
console.log(`\n${results.length - failed.length} of ${results.length} check(s) passed for phase ${phase}${failed.length ? `; failed: ${failed.map((result) => result.number).join(', ')}` : ''}`);
process.exit(failed.length || exitCode ? 1 : 0);
