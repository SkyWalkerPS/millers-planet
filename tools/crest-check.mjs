import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { evidenceDirectory } from './target.mjs';
import { measureImageRegions, parseRegion } from './measure-image.mjs';

const phase = process.env.PHASE || '7';
const shotName = 'crest-backlit';
const wholeImage = parseRegion('whole=frac:0,0,1,1');
const cropNames = ['crest', 'face'];
const problems = [];
const measuredCrops = {};

for (const cropName of cropNames) {
  const file = path.join(evidenceDirectory(), `${phase}-${shotName}-${cropName}.png`);
  if (!existsSync(file)) {
    problems.push(`${path.basename(file)} is missing; run PHASE=${phase} node tools/shoot.mjs ${shotName} first`);
    continue;
  }
  const { size, measured } = await measureImageRegions(file, [wholeImage]);
  const [whole] = measured;
  measuredCrops[cropName] = {
    file: path.basename(file),
    size,
    luminanceLinear: whole.luminanceLinear,
    blueGreenOverRed: whole.blueGreenOverRed,
    hueDegrees: whole.hueDegrees,
    meanLinear: whole.meanLinear,
  };
}

const { crest, face } = measuredCrops;
if (crest && face) {
  console.log(`crest band (${crest.file}, ${crest.size.width}x${crest.size.height}): Y ${crest.luminanceLinear.toFixed(3)}, (G+B)/2R ${crest.blueGreenOverRed.toFixed(3)}, hue ${crest.hueDegrees.toFixed(0)} degrees`);
  console.log(`wave face  (${face.file}, ${face.size.width}x${face.size.height}): Y ${face.luminanceLinear.toFixed(3)}, (G+B)/2R ${face.blueGreenOverRed.toFixed(3)}, hue ${face.hueDegrees.toFixed(0)} degrees`);
  if (!(crest.luminanceLinear > face.luminanceLinear)) problems.push(`the crest (Y ${crest.luminanceLinear.toFixed(3)}) is not brighter than the face (Y ${face.luminanceLinear.toFixed(3)})`);
  if (!(crest.blueGreenOverRed > face.blueGreenOverRed)) problems.push(`the crest ((G+B)/2R ${crest.blueGreenOverRed.toFixed(3)}) is not more blue-green than the face (${face.blueGreenOverRed.toFixed(3)})`);
}

writeFileSync(path.join(evidenceDirectory(), `${phase}-crest-check.json`), JSON.stringify({ shot: shotName, crops: measuredCrops, problems }, null, 2));
console.log(problems.length ? `FAIL\n  ${problems.join('\n  ')}` : 'PASS: the crest is brighter and more blue-green than the wave face');
process.exit(problems.length ? 1 : 0);
