import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { evidenceDirectory, openMillersPlanet } from './target.mjs';
import { pageExpression } from './page-results.mjs';
import { locomotionSettings } from '../src/character/suitController.js';

const shortestWalkSeconds = 80 / locomotionSettings.walkSpeedMetresPerSecond;
const longestWalkSeconds = 160 / locomotionSettings.walkSpeedMetresPerSecond;

const phase = Number(process.env.PHASE || 6);
const impactPoints = [[0, 0], [37.5, -12], [-140, 260], [512.25, 980.5], [-830, -415]];
const problems = [];
const target = await openMillersPlanet({ query: { scale: '0.7' } });
let report;
try {
  report = await target.page.evaluate(pageExpression(`(async () => {
    const api = window.millersPlanet;
    const relocations = [];
    for (const [impactX, impactZ] of ${JSON.stringify(impactPoints)}) {
      for (let waveIndex = 1; waveIndex <= 5; waveIndex++) {
        const relocation = api.debug.relocateShipForWave(waveIndex, impactX, impactZ);
        const ship = api.stats().ship;
        relocations.push({
          waveIndex,
          impact: [impactX, impactZ],
          distanceMetres: Math.hypot(relocation.x - impactX, relocation.z - impactZ),
          bearingFromTravelDegrees: relocation.bearingFromTravelRadians * 180 / Math.PI,
          state: ship.state,
          stateName: ship.stateName,
          visible: ship.visible,
        });
      }
    }
    const walks = [];
    for (const waveIndex of [1, 2, 3]) walks.push(api.debug.walkToShip({ waveIndex, impactX: 0, impactZ: 0 }));
    const collisions = api.debug.probeShipCollision();
    return { relocations, walks, collisions, openingShip: api.stats().ship };
  })()`), { timeoutMs: 600000 });
  for (const relocation of report.relocations) {
    if (relocation.waveIndex <= 4 && (relocation.distanceMetres < 100 || relocation.distanceMetres > 150)) problems.push(`wave ${relocation.waveIndex} from ${relocation.impact}: ship ${relocation.distanceMetres.toFixed(2)} m away (expected 100-150)`);
    if (Math.abs(relocation.bearingFromTravelDegrees) > 40.001) problems.push(`wave ${relocation.waveIndex}: ${relocation.bearingFromTravelDegrees.toFixed(1)} degrees off the wave's travel direction (expected within 40)`);
    const expectedState = Math.min(relocation.waveIndex, 4);
    if (relocation.state !== expectedState) problems.push(`after wave ${relocation.waveIndex} the ship state is ${relocation.state} (expected ${expectedState})`);
    if ((expectedState === 4) === relocation.visible) problems.push(`after wave ${relocation.waveIndex} the ship visible flag is ${relocation.visible}`);
  }
  for (const walk of report.walks) {
    if (!walk.reached) problems.push(`the walk after wave ${walk.waveIndex} never reached the ship (${walk.finalDistanceToHullMetres.toFixed(1)} m left)`);
    if (walk.secondsToReach < shortestWalkSeconds || walk.secondsToReach > longestWalkSeconds) problems.push(`the walk after wave ${walk.waveIndex} took ${walk.secondsToReach.toFixed(1)} s (expected ${shortestWalkSeconds.toFixed(0)}-${longestWalkSeconds.toFixed(0)} s: 80-160 m of wading at ${locomotionSettings.walkSpeedMetresPerSecond} m/s)`);
  }
  for (const collision of report.collisions) {
    if (collision.deepestPenetrationMetres > 0.02) problems.push(`state ${collision.state} (${collision.stateName}): a body sphere sank ${(collision.deepestPenetrationMetres * 100).toFixed(1)} cm into ${collision.deepestPenetrationBox} (limit 2 cm); ${collision.framesOverTwoCentimetres} frames over`);
    if (collision.closestCameraMetres < 0.2) problems.push(`state ${collision.state} (${collision.stateName}): the camera came within ${collision.closestCameraMetres.toFixed(3)} m of ${collision.closestCameraBox} (limit 0.20 m)`);
    if (collision.framesInContact === 0) problems.push(`state ${collision.state} (${collision.stateName}): the walks never touched the ship, so the probe tested nothing`);
  }
  if (report.openingShip.state !== 0 || report.openingShip.distanceFromAstronautMetres < 15 || report.openingShip.distanceFromAstronautMetres > 25) problems.push(`opening ship state ${report.openingShip.state}, ${report.openingShip.distanceFromAstronautMetres.toFixed(1)} m away (expected intact, 15-25 m)`);
  const pageErrors = target.page.pageErrors();
  if (pageErrors.length) problems.push(`page errors: ${pageErrors.map((event) => event.text).join(' | ')}`);
} finally {
  await target.close();
}
mkdirSync(evidenceDirectory(), { recursive: true });
writeFileSync(path.join(evidenceDirectory(), `${phase}-ship-check.json`), JSON.stringify({ ...report, problems }, null, 2));
const distances = report.relocations.filter((relocation) => relocation.waveIndex <= 4).map((relocation) => relocation.distanceMetres);
console.log(`relocations: ${report.relocations.length} (5 impact points x waves 1-5); distances ${Math.min(...distances).toFixed(1)}-${Math.max(...distances).toFixed(1)} m; states ${[...new Set(report.relocations.map((relocation) => `${relocation.waveIndex}->${relocation.state}`))].join(', ')}`);
for (const walk of report.walks) console.log(`walk after wave ${walk.waveIndex}: ship ${walk.relocationDistanceMetres.toFixed(1)} m away, reached the hull in ${walk.secondsToReach.toFixed(1)} s (${(walk.secondsToReach / 60).toFixed(2)} min), ${walk.walkedMetres.toFixed(1)} m walked at ${walk.averageSpeedMetresPerSecond.toFixed(3)} m/s`);
for (const collision of report.collisions) console.log(`collision, ${collision.stateName}: ${collision.approaches} walks into the ship from 16 m, ${collision.framesInContact} frames in contact; deepest body overlap ${(collision.deepestPenetrationMetres * 100).toFixed(2)} cm (${collision.deepestPenetrationBox}); camera at least ${collision.closestCameraMetres.toFixed(3)} m from any box (${collision.closestCameraBox}), largest camera step in one frame ${(collision.largestCameraStepMetres * 100).toFixed(1)} cm, ${collision.cameraJumpsOverHalfMetre} jumps over 0.5 m in ${collision.simulatedSeconds.toFixed(0)} s`);
console.log(`opening: ship ${report.openingShip.stateName}, ${report.openingShip.distanceFromAstronautMetres.toFixed(1)} m from the astronaut`);
console.log(problems.length ? `FAIL\n  ${problems.join('\n  ')}` : 'PASS');
process.exit(problems.length ? 1 : 0);
