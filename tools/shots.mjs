import { pageExpression } from './page-results.mjs';

export const SHOT_KINDS = {
  still: 'one frame after the scene settles',
  freshLoad: 'the first frame after a fresh page load, shot before any other setup',
  afterReload: 'the first frame after page.reload()',
  sequence: 'a frame sequence (needs a later hero-clip tool)',
  byTool: 'made by another tool (named in madeBy), not by shoot.mjs',
};

const shipStateShots = [0, 1, 2, 3, 4].map((state) => ({
  name: `ship-${state}`,
  phase: 6,
  kind: 'still',
  setup: [['setShipState', state]],
  description: `Ship damage state ${state}`,
}));

const shipFromLandingShots = [1, 2, 3].map((waveCount) => ({
  name: `ship-${waveCount}-from-landing`,
  phase: 7,
  kind: 'byTool',
  madeBy: 'tools/wave-run.mjs',
  waveSecondsFromImpact: 21,
  expectedCrops: ['ship'],
  description: `The relocated ship after wave ${waveCount}, seen through the haze from where the astronaut landed`,
}));

export const SHOTS = [
  { name: 'empty', phase: 2, kind: 'still', benchmarkByDefault: true, description: 'Empty scene through the full post chain (jittered test pattern)' },
  { name: 'debug-orbit-a', phase: 2, kind: 'still', benchmarkByDefault: true, description: 'Debug orbit camera over the test scene, view A' },
  { name: 'debug-orbit-b', phase: 2, kind: 'still', description: 'Debug orbit camera over the test scene, view B' },
  { name: 'spike-ground', phase: 2, kind: 'still', benchmarkByDefault: true, description: 'The ground whose material samples the compute-written texture (spike S0)' },

  { name: 'sky-gargantua', phase: 3, kind: 'still', benchmarkByDefault: true, description: 'Eye height 1.7 m facing Gargantua, gameplay field of view' },
  { name: 'sky-gargantua-tele', phase: 3, kind: 'still', description: 'Debug 20 degree field of view on the disk (lensing detail)' },
  { name: 'sky-away', phase: 3, kind: 'still', description: 'Facing away from Gargantua' },
  { name: 'sky-zenith', phase: 3, kind: 'still', description: 'Looking up 60 degrees' },

  { name: 'sea-wide', phase: 4, kind: 'still', benchmarkByDefault: true, description: 'Eye height toward Gargantua (glitter path)' },
  { name: 'sea-away', phase: 4, kind: 'still', description: 'Eye height away from Gargantua' },
  { name: 'sea-close', phase: 4, kind: 'still', description: '0.8 m up, 50 degrees down: the bed through the water' },
  { name: 'sea-ripples', phase: 4, kind: 'still', description: 'Close shot after scripted footstep impulses' },
  { name: 'taau-ghost', phase: 4, kind: 'byTool', madeBy: 'tools/motion-check.mjs', description: 'A static frame and two consecutive frames of a fast pan over the glitter path (temporal upscaling ghost check)' },

  { name: 'astro-third', phase: 5, kind: 'still', setup: [['setViewPreset', 0]], description: 'Third-person preset' },
  { name: 'astro-close', phase: 5, kind: 'still', setup: [['setViewPreset', 1]], description: 'Close third-person preset' },
  { name: 'astro-first', phase: 5, kind: 'still', setup: [['setViewPreset', 2]], benchmarkByDefault: true, description: 'First-person preset with the faint helmet rim' },
  { name: 'visor-front-gargantua', phase: 5, kind: 'still', expectedCrops: ['visor'], benchmarkByDefault: true, description: 'Camera in front, astronaut facing Gargantua; visor crop' },
  { name: 'walk-ripples', phase: 5, kind: 'still', settleFrames: 240, description: 'Mid-walk, close preset; ripples at the shins (240 settle frames so all 198 footstep stamps of the scripted walk land)' },
  { name: 'walk-splash', phase: 7, kind: 'still', settleFrames: 240, description: 'Mid-walk with Shift, close preset from the side: wake and foam at the shins (droplets deferred to phase 8)' },

  { name: 'hud', phase: 6, kind: 'still', description: 'Full frame with the clocks' },
  ...shipStateShots,
  { name: 'ship-0-silhouette', phase: 6, kind: 'still', setup: [['setShipState', 0]], description: 'Flat silhouette of the intact lander (no markings check)' },
  { name: 'camera-collide-ship', phase: 6, kind: 'still', description: 'Camera orbited into the lander' },
  { name: 'opening', phase: 6, kind: 'freshLoad', freezeTime: 0, benchmarkByDefault: true, description: 'First frame after load' },
  { name: 'opening-reload', phase: 6, kind: 'afterReload', freezeTime: 0, description: 'First frame after a reload' },

  { name: 'wave-incoming-far', phase: 7, kind: 'still', waveSecondsFromImpact: -210, description: 'T-210 (30 s after load): the first wave about 42 km out, rising from the sea' },
  { name: 'wave-a-far', phase: 7, kind: 'still', waveSecondsFromImpact: -60, description: 'The wave as distant mountains at T-60' },
  { name: 'wave-a-move', phase: 7, kind: 'still', waveSecondsFromImpact: -59, description: 'T-59, to compare with T-60 for motion' },
  { name: 'wave-a-near', phase: 7, kind: 'still', waveSecondsFromImpact: -30, description: 'T-30' },
  { name: 'crest-backlit', phase: 7, kind: 'still', waveSecondsFromImpact: -35, expectedCrops: ['crest', 'face'], benchmarkByDefault: true, description: 'T-35, crest level with Gargantua: backlit crest' },
  { name: 'visor-front-wave', phase: 7, kind: 'still', waveSecondsFromImpact: -3, expectedCrops: ['visor'], benchmarkByDefault: true, description: 'Scripted brace camera at T-3; visor crop shows the wall and crest' },
  { name: 'wave-ride-swept', phase: 7, kind: 'still', waveSecondsFromImpact: 0.8, description: 'T+0.8, swept off his feet and carried up the face' },
  { name: 'wave-ride-up', phase: 7, kind: 'still', waveSecondsFromImpact: 2.6, description: 'T+2.6, about 1.5 km up the face' },
  { name: 'wave-b-brace', phase: 7, kind: 'still', waveSecondsFromImpact: -6, benchmarkByDefault: true, description: 'T-6, braced on one knee, camera looking up at the wall' },
  { name: 'wave-c-crest', phase: 7, kind: 'still', waveSecondsFromImpact: 4.2, benchmarkByDefault: true, description: 'T+4.2, thrown above the crest with the sea 2.4 km below' },
  { name: 'wave-ride-back', phase: 7, kind: 'still', waveSecondsFromImpact: 6.2, description: 'T+6.2, sliding down the back slope' },
  { name: 'wave-ride-splash', phase: 7, kind: 'still', waveSecondsFromImpact: 9.4, description: 'T+9.4, splashdown on the far side' },
  { name: 'wave-d-drain', phase: 7, kind: 'still', waveSecondsFromImpact: 12, description: 'T+12, the water draining as he gets up' },
  { name: 'wave-after', phase: 7, kind: 'still', waveSecondsFromImpact: 18, description: 'T+18, control back' },
  { name: 'wave-receding', phase: 7, kind: 'still', waveSecondsFromImpact: 30, description: 'T+30, looking back at the wave moving away' },
  { name: 'wave-receding-far', phase: 7, kind: 'still', waveSecondsFromImpact: 100, description: 'T+100, the passed wave 20 km away' },
  { name: 'wave-previous-at-impact', phase: 7, kind: 'still', waveSecondsFromImpact: 234, description: 'Wave 2 at T-6, looking back: wave 1 is a small ridge about 47 km away' },
  ...shipFromLandingShots,
  { name: 'hero-clip', phase: 9, kind: 'sequence', waveSecondsFromImpact: -22, description: 'T-22 to T+8 at 60 fps on a virtual clock (hero-clip tool, later)' },
];

const duplicateNames = SHOTS.map((shot) => shot.name).filter((name, index, names) => names.indexOf(name) !== index);
if (duplicateNames.length) throw new Error(`Duplicate shot names in tools/shots.mjs: ${duplicateNames.join(', ')}`);

export function findShot(name) {
  return SHOTS.find((shot) => shot.name === name) || null;
}

export function shotsForPhase(phase) {
  return SHOTS.filter((shot) => shot.phase === phase || (shot.alsoPhases || []).includes(phase));
}

export function shotSetupSteps(shot) {
  const steps = [];
  if (shot.freezeTime !== undefined) steps.push(['freezeTime', shot.freezeTime]);
  steps.push(...(shot.setup || []));
  if (shot.kind !== 'freshLoad' && shot.kind !== 'afterReload') steps.push(['setCameraShot', shot.name]);
  return steps;
}

export async function applyShotSetup(page, shot) {
  const steps = shotSetupSteps(shot);
  return page.evaluate(pageExpression(`(async () => {
    const api = window.millersPlanet;
    let lastResult = null;
    for (const [methodName, ...methodArguments] of ${JSON.stringify(steps)}) {
      if (typeof api[methodName] !== 'function') throw new Error('millersPlanet.' + methodName + ' is not a function');
      lastResult = await api[methodName](...methodArguments);
    }
    return lastResult;
  })()`));
}

export function selectShots(argumentList, defaultPhase) {
  const selections = argumentList.length ? argumentList : [String(defaultPhase)];
  const selected = [];
  for (const selection of selections) {
    if (/^\d+$/.test(selection)) {
      const phaseShots = shotsForPhase(Number(selection));
      if (!phaseShots.length) throw new Error(`No shots are listed for phase ${selection} in tools/shots.mjs`);
      selected.push(...phaseShots);
      continue;
    }
    const shot = findShot(selection);
    if (!shot) throw new Error(`Unknown shot "${selection}". Known shots: ${SHOTS.map((entry) => entry.name).join(', ')}`);
    selected.push(shot);
  }
  return selected.filter((shot, index) => selected.indexOf(shot) === index);
}
