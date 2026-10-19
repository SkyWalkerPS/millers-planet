import { openMillersPlanet } from './target.mjs';
import { pageExpression } from './page-results.mjs';
import { impactSecondsOf, waveStateAt } from '../src/wave/waveTimeline.js';
import { formatImpactCountdown } from '../src/hud/clocks.js';

const frozenSeconds = Number(process.env.FROZEN_SECONDS || 6);
const smallestClockShareOfRealTime = 0.9;
const problems = [];

const readClock = (page) => page.evaluate(pageExpression(`(() => {
  const clocks = window.millersPlanet.stats().clocks;
  return { millerSeconds: clocks.millerSeconds, waveText: clocks.panelWaveText, countdownText: clocks.panelCountdownText, countdownVisible: clocks.countdownVisible };
})()`));

const target = await openMillersPlanet();
try {
  const page = target.page;
  await page.evaluate(pageExpression(`(async () => { window.millersPlanet.freezeTime(null); await window.millersPlanet.renderFrames(2); return true; })()`));
  const before = await readClock(page);
  const realStartMs = Date.now();
  await page.evaluate(pageExpression(`(() => {
    const realRequestAnimationFrame = window.requestAnimationFrame.bind(window);
    const heldCallbacks = [];
    window.requestAnimationFrame = (callback) => { heldCallbacks.push(callback); return 0; };
    window.releaseHeldAnimationFrames = () => {
      window.requestAnimationFrame = realRequestAnimationFrame;
      for (const callback of heldCallbacks.splice(0)) realRequestAnimationFrame(callback);
      return true;
    };
    return true;
  })()`));
  await new Promise((resolve) => setTimeout(resolve, frozenSeconds * 1000));
  const clockWhileHidden = await readClock(page);
  await page.evaluate(pageExpression(`window.releaseHeldAnimationFrames()`));
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (clockWhileHidden.millerSeconds - before.millerSeconds > 0.5) problems.push(`frames kept being drawn while they were held back (clock moved ${(clockWhileHidden.millerSeconds - before.millerSeconds).toFixed(2)} s), so this run did not imitate a hidden tab`);
  const after = await readClock(page);
  const realElapsedSeconds = (Date.now() - realStartMs) / 1000;
  const clockElapsedSeconds = after.millerSeconds - before.millerSeconds;
  console.log(`frames held back for ${frozenSeconds} s, as in a hidden tab: real time ${realElapsedSeconds.toFixed(2)} s, game clock ${clockElapsedSeconds.toFixed(2)} s`);
  if (clockElapsedSeconds < realElapsedSeconds * smallestClockShareOfRealTime) problems.push(`the game clock advanced ${clockElapsedSeconds.toFixed(2)} s while ${realElapsedSeconds.toFixed(2)} s of real time passed with no frames drawn`);
  if (clockElapsedSeconds > realElapsedSeconds + 0.5) problems.push(`the game clock ran ahead of real time (${clockElapsedSeconds.toFixed(2)} s against ${realElapsedSeconds.toFixed(2)} s)`);
  const state = waveStateAt(after.millerSeconds);
  const expectedCountdown = formatImpactCountdown(impactSecondsOf(state.index) - after.millerSeconds);
  console.log(`countdown panel: wave ${after.waveText}, impact in ${after.countdownText} (expected wave ${state.index}, ${expectedCountdown}), visible ${after.countdownVisible}`);
  if (!after.countdownVisible) problems.push('the countdown panel is hidden');
  if (after.waveText !== `${state.index}`) problems.push(`the countdown panel shows wave ${after.waveText}, expected ${state.index}`);
  if (after.countdownText !== expectedCountdown) problems.push(`the countdown panel shows ${after.countdownText}, expected ${expectedCountdown}`);
} finally {
  await target.close();
}
console.log(problems.length ? `FAIL\n  ${problems.join('\n  ')}` : 'PASS');
process.exit(problems.length ? 1 : 0);
