import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { sleep } from './cdp.mjs';
import { evidenceDirectory, openMillersPlanet, startMillersPlanetServer } from './target.mjs';
import { pageExpression } from './page-results.mjs';

const phase = Number(process.env.PHASE || 2);
const CHECK_TITLES = {
  1: 'start-up: ready, full-resolution canvas, no console errors',
  2: 'opening state: preset 0, player camera behind the astronaut, ship nearby, nothing locked or playing',
  3: 'only the clocks on screen, top-left glass panel',
  4: 'first click locks the pointer and starts audio, with no new page elements',
  5: 'the mouse wheel changes nothing',
  6: 'ctrl+wheel changes nothing',
  7: 'trackpad pinch and the + - = _ keys change nothing',
  8: 'WASD and arrow keys walk at 0.8-1.25 m/s relative to the camera',
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
const NOT_WRITTEN_YET = new Set([2, 3, 8, 9, 10, 11, 12, 13, 14]);
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

    for (const number of [2, 3]) if (shouldRun(number)) record(number, false, `not written yet: this check arrives with phase ${CHECK_PHASES[number]}`);

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

    for (const number of [8, 9, 10, 11, 12, 13, 14]) if (shouldRun(number)) record(number, false, `not written yet: this check arrives with phase ${CHECK_PHASES[number]}`);

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
