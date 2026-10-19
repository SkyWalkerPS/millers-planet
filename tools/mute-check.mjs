import { openMillersPlanet, startMillersPlanetServer, waitForMillersPlanetReady } from './target.mjs';
import { pageExpression } from './page-results.mjs';
import { sleep } from './cdp.mjs';

const problems = [];

const layoutAndSound = (page) => page.evaluate(pageExpression(`(() => {
  const box = (id) => document.getElementById(id).getBoundingClientRect();
  const button = box('mute-button');
  const clocks = box('clocks');
  const stats = window.millersPlanet.stats();
  return {
    muted: stats.audio.muted,
    audioState: stats.audio.state,
    buttonLabel: document.getElementById('mute-button').getAttribute('aria-label'),
    buttonTop: button.top, buttonHeight: button.height, buttonRight: button.right, buttonLeft: button.left,
    clocksTop: clocks.top, clocksHeight: clocks.height,
    countdownRight: box('wave-countdown').right,
    innerWidth,
  };
})()`));

function checkLayout(label, state) {
  if (Math.abs(state.buttonTop - state.clocksTop) > 1) problems.push(`${label}: the mute button's top (${state.buttonTop.toFixed(1)} px) is not level with the clock boxes (${state.clocksTop.toFixed(1)} px)`);
  if (Math.abs(state.buttonHeight - state.clocksHeight) > 1) problems.push(`${label}: the mute button is ${state.buttonHeight.toFixed(1)} px tall, the clock boxes ${state.clocksHeight.toFixed(1)} px`);
  if (state.innerWidth - state.buttonRight > 24) problems.push(`${label}: the mute button is not at the right edge (${(state.innerWidth - state.buttonRight).toFixed(0)} px from it)`);
  if (state.buttonLeft < state.countdownRight) problems.push(`${label}: the mute button overlaps the countdown box`);
}

const server = await startMillersPlanetServer({});
try {
  const desktop = await openMillersPlanet({ server });
  try {
    const page = desktop.page;
    const initial = await layoutAndSound(page);
    console.log(`desktop: starts ${initial.muted ? 'muted' : 'with sound on'}; button ${initial.buttonHeight.toFixed(1)} px tall at the top right, clocks ${initial.clocksHeight.toFixed(1)} px`);
    checkLayout('desktop', initial);
    if (initial.muted) problems.push('desktop: starts muted (expected sound on)');
    await page.click(400, 600);
    await sleep(400);
    const afterClick = await layoutAndSound(page);
    if (afterClick.audioState !== 'running') problems.push(`desktop: the first click left the sound ${afterClick.audioState}`);
    await page.keyPress('KeyM');
    await sleep(300);
    const afterMute = await layoutAndSound(page);
    if (!afterMute.muted || afterMute.audioState === 'running') problems.push(`desktop: M did not mute (muted ${afterMute.muted}, sound ${afterMute.audioState})`);
    await page.keyPress('KeyM');
    await sleep(300);
    const afterUnmute = await layoutAndSound(page);
    if (afterUnmute.muted || afterUnmute.audioState !== 'running') problems.push(`desktop: a second M did not bring the sound back (muted ${afterUnmute.muted}, sound ${afterUnmute.audioState})`);
    await page.evaluate(`(async () => { document.exitPointerLock(); await new Promise((resolve) => setTimeout(resolve, 200)); return document.pointerLockElement === null; })()`);
    await page.click(afterUnmute.buttonLeft + 10, afterUnmute.buttonTop + afterUnmute.buttonHeight / 2);
    await sleep(300);
    const afterButton = await layoutAndSound(page);
    if (!afterButton.muted) problems.push('desktop: clicking the button did not mute');
    await page.goto(desktop.url);
    await waitForMillersPlanetReady(page);
    const afterReload = await layoutAndSound(page);
    if (!afterReload.muted) problems.push('desktop: the muted choice was not remembered after a reload');
    console.log(`desktop: first click -> ${afterClick.audioState}; M -> muted ${afterMute.muted} (${afterMute.audioState}); M -> muted ${afterUnmute.muted} (${afterUnmute.audioState}); button -> muted ${afterButton.muted}; after reload muted ${afterReload.muted}`);
  } finally {
    await desktop.browser.shutdown();
  }

  const phone = await openMillersPlanet({ server, viewport: { width: 390, height: 844, deviceScaleFactor: 3 }, waitUntilReady: false });
  try {
    const page = phone.page;
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await page.goto(phone.url);
    await waitForMillersPlanetReady(page);
    const initial = await layoutAndSound(page);
    console.log(`phone: starts ${initial.muted ? 'muted' : 'with sound on'}; button ${initial.buttonHeight.toFixed(1)} px tall, clocks ${initial.clocksHeight.toFixed(1)} px; label "${initial.buttonLabel}"`);
    checkLayout('phone', initial);
    if (!initial.muted) problems.push('phone: starts with sound on (expected muted)');
    const touchAt = async (x, y) => {
      await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }] });
      await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    await touchAt(300, 400);
    await sleep(400);
    const afterTouch = await layoutAndSound(page);
    if (afterTouch.audioState === 'running') problems.push('phone: touching the game started the sound while muted');
    await touchAt(initial.buttonLeft + 10, initial.buttonTop + initial.buttonHeight / 2);
    await sleep(500);
    const afterTap = await layoutAndSound(page);
    if (afterTap.muted || afterTap.audioState !== 'running') problems.push(`phone: tapping the button did not turn the sound on (muted ${afterTap.muted}, sound ${afterTap.audioState})`);
    console.log(`phone: touch the game -> sound ${afterTouch.audioState}; tap the button -> muted ${afterTap.muted}, sound ${afterTap.audioState}`);
    const pageErrors = page.pageErrors();
    if (pageErrors.length) problems.push(`page errors: ${pageErrors.map((event) => event.text).join(' | ')}`);
  } finally {
    await phone.browser.shutdown();
  }
} finally {
  await server.close();
}
console.log(problems.length ? `FAIL\n  ${problems.join('\n  ')}` : 'PASS');
process.exit(problems.length ? 1 : 0);
