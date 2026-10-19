import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { evidenceDirectory, openMillersPlanet, waitForMillersPlanetReady } from './target.mjs';
import { pageExpression } from './page-results.mjs';
import { sleep } from './cdp.mjs';
import { locomotionSettings } from '../src/character/suitController.js';

const phase = Number(process.env.PHASE || 7);
const phoneViewport = { width: Number(process.env.PHONE_WIDTH || 390), height: Number(process.env.PHONE_HEIGHT || 844), deviceScaleFactor: 3 };
const holdSeconds = 3;
const problems = [];
const report = { viewport: phoneViewport };

const target = await openMillersPlanet({ viewport: phoneViewport, waitUntilReady: false });
try {
  const page = target.page;
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await page.goto(target.url);
  await waitForMillersPlanetReady(page);

  const state = () => page.evaluate(pageExpression(`(() => {
    const stats = window.millersPlanet.stats();
    const visible = (id) => { const element = document.getElementById(id); return Boolean(element) && getComputedStyle(element).display !== 'none' && Number(getComputedStyle(element).opacity) > 0.05; };
    return {
      position: stats.astronaut.position,
      speed: stats.astronaut.horizontalSpeed,
      cameraYawDegrees: stats.camera.rigYawDegrees,
      preset: stats.camera.preset,
      fovDegrees: stats.camera.fovDegrees,
      joystickVisible: visible('touch-joystick'),
      viewButtonVisible: visible('touch-view-button'),
      hintVisible: visible('touch-hint'),
      hintBottom: document.getElementById('touch-hint').getBoundingClientRect().bottom,
      hintRight: document.getElementById('touch-hint').getBoundingClientRect().right,
      viewButtonTop: document.getElementById('touch-view-button').getBoundingClientRect().top,
      joystick: (() => { const box = document.getElementById('touch-joystick').getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2, top: box.top, left: box.left, right: box.right, bottom: box.bottom, radius: box.width / 2 }; })(),
      knobOffset: (() => { const matrix = new DOMMatrix(getComputedStyle(document.getElementById('touch-joystick-knob')).transform); return Math.hypot(matrix.m41, matrix.m42); })(),
      hudRight: document.getElementById('hud').getBoundingClientRect().right,
      viewButtonLeft: document.getElementById('touch-view-button').getBoundingClientRect().left,
      clocksHeight: document.getElementById('clocks').getBoundingClientRect().height,
      countdownHeight: document.getElementById('wave-countdown').getBoundingClientRect().height,
      innerWidth,
    };
  })()`));
  const touch = (type, points) => page.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y, id]) => ({ x, y, id, radiusX: 4, radiusY: 4, force: 1 })) });

  await page.evaluate(pageExpression(`(async () => {
    window.millersPlanet.debug.enterPlayerMode();
    window.millersPlanet.freezeTime(null);
    window.millersPlanet.debug.setAstronautPosition({ x: 0, z: 0, yawDegrees: 0, cameraYawDegrees: 0 });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return true;
  })()`));

  const start = await state();
  report.start = start;
  if (!start.viewButtonVisible) problems.push('the View button is not shown on a touch device');
  if (!start.joystickVisible) problems.push('the walk circle is not shown on a touch device');
  if (Math.abs(start.joystick.x - start.innerWidth / 2) > 2) problems.push(`the walk circle is not centred (${start.joystick.x.toFixed(0)} of ${start.innerWidth} px)`);
  if (start.joystick.bottom < phoneViewport.height * 0.75) problems.push(`the walk circle is not at the bottom (its lower edge is at ${start.joystick.bottom.toFixed(0)} of ${phoneViewport.height} px)`);
  if (start.hintBottom > start.joystick.top) problems.push('the touch hint overlaps the walk circle');
  if (start.joystick.right > start.viewButtonLeft && start.joystick.bottom > start.viewButtonTop) problems.push('the walk circle overlaps the View button');
  if (!start.hintVisible) problems.push('the touch hint is not shown before the first touch');
  if (start.hintBottom > start.viewButtonTop && start.hintRight > start.viewButtonLeft) problems.push('the touch hint overlaps the View button');
  if (start.hudRight > start.innerWidth) problems.push(`the clock boxes run off the screen (right edge ${start.hudRight.toFixed(0)} of ${start.innerWidth} px)`);
  if (start.clocksHeight > start.countdownHeight + 2 || start.countdownHeight > start.clocksHeight + 2) problems.push(`the clock boxes have different heights (${start.clocksHeight.toFixed(1)} and ${start.countdownHeight.toFixed(1)} px), so a line wrapped`);

  const walkRight = async (dragPixels, label) => {
    const before = await state();
    const thumbX = before.joystick.x;
    const thumbY = before.joystick.y;
    await touch('touchStart', [[thumbX, thumbY, 1]]);
    for (let step = 1; step <= 6; step++) {
      await touch('touchMove', [[thumbX + (dragPixels * step) / 6, thumbY, 1]]);
      await sleep(16);
    }
    await sleep(1000);
    const settled = await state();
    await sleep(holdSeconds * 1000);
    const held = await state();
    await touch('touchEnd', []);
    await sleep(900);
    const released = await state();
    const yaw = (before.cameraYawDegrees * Math.PI) / 180;
    const rightX = Math.cos(yaw);
    const rightZ = -Math.sin(yaw);
    const forwardX = Math.sin(yaw);
    const forwardZ = Math.cos(yaw);
    const movedX = held.position[0] - settled.position[0];
    const movedZ = held.position[2] - settled.position[2];
    const rightward = movedX * rightX + movedZ * rightZ;
    const forward = movedX * forwardX + movedZ * forwardZ;
    const result = { label, dragPixels, averageSpeed: Math.hypot(movedX, movedZ) / holdSeconds, rightwardMetres: rightward, forwardMetres: forward, knobOffsetWhileHeld: settled.knobOffset, knobOffsetAfterRelease: released.knobOffset, speedAfterRelease: released.speed };
    console.log(`${label}: dragged ${dragPixels} px right and held ${holdSeconds} s; moved ${rightward.toFixed(2)} m right and ${forward.toFixed(2)} m forward relative to the camera (${result.averageSpeed.toFixed(2)} m/s); speed ${released.speed.toFixed(2)} m/s 0.9 s after letting go`);
    return result;
  };

  await page.evaluate(pageExpression(`(() => {
    const canvas = document.querySelector('canvas');
    const box = document.getElementById('touch-joystick').getBoundingClientRect();
    canvas.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 77, pointerType: 'touch', isPrimary: true, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2, bubbles: true, cancelable: true }));
    return true;
  })()`));
  console.log('a stray touch was started on the walk circle and its finger-up never sent, as when a browser drops one');
  const walk = await walkRight(70, 'walk');
  report.walk = walk;
  const expectedWalk = locomotionSettings.walkSpeedMetresPerSecond;
  if (walk.rightwardMetres < expectedWalk * holdSeconds * 0.8) problems.push(`holding the joystick right moved the astronaut only ${walk.rightwardMetres.toFixed(2)} m right in ${holdSeconds} s (expected about ${(expectedWalk * holdSeconds).toFixed(1)} m)`);
  if (Math.abs(walk.forwardMetres) > walk.rightwardMetres * 0.25) problems.push(`holding right drifted ${walk.forwardMetres.toFixed(2)} m forward or back (the walk curved instead of going right)`);
  if (walk.knobOffsetWhileHeld < start.joystick.radius * 0.9) problems.push(`the knob did not follow the thumb (offset ${walk.knobOffsetWhileHeld.toFixed(1)} px)`);
  if (walk.knobOffsetAfterRelease > 1) problems.push(`the knob did not spring back to the centre after letting go (offset ${walk.knobOffsetAfterRelease.toFixed(1)} px)`);
  if (walk.speedAfterRelease > 0.2) problems.push(`the astronaut kept moving at ${walk.speedAfterRelease.toFixed(2)} m/s after letting go`);
  const afterFirstTouch = await state();
  if (afterFirstTouch.hintVisible) problems.push('the touch hint is still shown after the first walk');

  const run = await walkRight(110, 'run');
  report.run = run;
  const expectedRun = locomotionSettings.shiftSpeedMetresPerSecond;
  if (run.averageSpeed < expectedRun * 0.85) problems.push(`pushing past the ring gave ${run.averageSpeed.toFixed(2)} m/s (expected about ${expectedRun} m/s, the Shift speed)`);

  const outsideCircleBefore = await state();
  const outsideX = phoneViewport.width * 0.15;
  const outsideY = phoneViewport.height * 0.5;
  await touch('touchStart', [[outsideX, outsideY, 4]]);
  for (let step = 1; step <= 10; step++) {
    await touch('touchMove', [[outsideX + step * 8, outsideY, 4]]);
    await sleep(16);
  }
  await sleep(1500);
  const outsideCircleHeld = await state();
  await touch('touchEnd', []);
  await sleep(300);
  const outsideTurned = ((outsideCircleHeld.cameraYawDegrees - outsideCircleBefore.cameraYawDegrees + 540) % 360) - 180;
  const outsideMoved = Math.hypot(outsideCircleHeld.position[0] - outsideCircleBefore.position[0], outsideCircleHeld.position[2] - outsideCircleBefore.position[2]);
  report.dragOutsideCircle = { turnedDegrees: outsideTurned, movedMetres: outsideMoved };
  console.log(`drag outside the circle (left side, mid-height): the camera turned ${outsideTurned.toFixed(1)} degrees and the astronaut moved ${outsideMoved.toFixed(2)} m`);
  if (outsideMoved > 0.05) problems.push(`a drag outside the circle moved the astronaut ${outsideMoved.toFixed(2)} m (it should only look)`);
  if (outsideTurned < 20) problems.push(`a drag outside the circle turned the camera only ${outsideTurned.toFixed(1)} degrees`);

  const beforeLook = await state();
  const lookX = phoneViewport.width * 0.7;
  const lookY = phoneViewport.height * 0.45;
  await touch('touchStart', [[lookX, lookY, 2]]);
  for (let step = 1; step <= 10; step++) {
    await touch('touchMove', [[lookX + step * 8, lookY, 2]]);
    await sleep(16);
  }
  await touch('touchEnd', []);
  await sleep(300);
  const afterLook = await state();
  const turnedDegrees = ((afterLook.cameraYawDegrees - beforeLook.cameraYawDegrees + 540) % 360) - 180;
  report.look = { turnedDegrees, positionChangeMetres: Math.hypot(afterLook.position[0] - beforeLook.position[0], afterLook.position[2] - beforeLook.position[2]) };
  console.log(`look: dragged 80 px right on the right half; the camera turned ${turnedDegrees.toFixed(1)} degrees and the astronaut moved ${report.look.positionChangeMetres.toFixed(2)} m`);
  if (turnedDegrees < 20) problems.push(`dragging on the right half turned the camera only ${turnedDegrees.toFixed(1)} degrees`);
  if (report.look.positionChangeMetres > 0.05) problems.push('looking around also moved the astronaut');

  const viewButton = await page.evaluate(pageExpression(`(() => { const box = document.getElementById('touch-view-button').getBoundingClientRect(); return [box.left + box.width / 2, box.top + box.height / 2]; })()`));
  await touch('touchStart', [[viewButton[0], viewButton[1], 3]]);
  await touch('touchEnd', []);
  await sleep(300);
  const afterView = await state();
  report.viewButton = { presetBefore: afterLook.preset, presetAfter: afterView.preset };
  console.log(`View button: preset ${afterLook.preset} -> ${afterView.preset}`);
  if (afterView.preset === afterLook.preset) problems.push('tapping View did not change the camera view');
  if (Math.hypot(afterView.position[0] - afterLook.position[0], afterView.position[2] - afterLook.position[2]) > 0.05) problems.push('tapping View also moved the astronaut');

  mkdirSync(evidenceDirectory(), { recursive: true });
  await page.evaluate(pageExpression(`(async () => { window.millersPlanet.debug.setAstronautPosition({ x: 0, z: 0, yawDegrees: 0, cameraYawDegrees: 0 }); return true; })()`));
  const pageErrors = page.pageErrors();
  if (pageErrors.length) problems.push(`page errors: ${pageErrors.map((event) => event.text).join(' | ')}`);
  report.problems = problems;
  writeFileSync(path.join(evidenceDirectory(), `${phase}-touch-check-${phoneViewport.width}x${phoneViewport.height}.json`), JSON.stringify(report, null, 2));
} finally {
  await target.close();
}
console.log(problems.length ? `FAIL\n  ${problems.join('\n  ')}` : 'PASS');
process.exit(problems.length ? 1 : 0);
