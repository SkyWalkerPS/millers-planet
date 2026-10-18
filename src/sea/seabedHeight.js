function permutedCongruentialHash(value) {
    const state = (Math.imul(value, 747796405) + 2891336453) >>> 0;
    const word = Math.imul(((state >>> ((state >>> 28) + 4)) ^ state) >>> 0, 277803737) >>> 0;
    return ((word >>> 22) ^ word) >>> 0;
}

function latticeGradientFromHashBits(cellX, cellY, target) {
    const hashed = permutedCongruentialHash((Math.imul(cellX | 0, 0x8da6b343) ^ Math.imul(cellY | 0, 0xd8163841)) >>> 0);
    target[0] = (hashed & 0xffff) * (2 / 65535) - 1;
    target[1] = (hashed >>> 16) * (2 / 65535) - 1;
    return target;
}

const cornerGradient = new Float64Array(2);

function cornerContribution(cellX, cellY, offsetX, offsetY) {
    latticeGradientFromHashBits(cellX, cellY, cornerGradient);
    return cornerGradient[0] * offsetX + cornerGradient[1] * offsetY;
}

export function trigonometryFreeGradientNoise(x, y) {
    const cellX = Math.floor(x);
    const cellY = Math.floor(y);
    const localX = x - cellX;
    const localY = y - cellY;
    const fadeX = localX * localX * localX * (localX * (localX * 6 - 15) + 10);
    const fadeY = localY * localY * localY * (localY * (localY * 6 - 15) + 10);
    const a = cornerContribution(cellX, cellY, localX, localY);
    const b = cornerContribution(cellX + 1, cellY, localX - 1, localY);
    const c = cornerContribution(cellX, cellY + 1, localX, localY - 1);
    const d = cornerContribution(cellX + 1, cellY + 1, localX - 1, localY - 1);
    const lower = a + (b - a) * fadeX;
    const upper = c + (d - c) * fadeX;
    return 1.73 * (lower + (upper - lower) * fadeY);
}

export function createSeabedHeightFunction({ meanDepthMetres, depthVariationMetres, featureScalePerMetre, waterLevelMetres = 0 }) {
    return function seabedHeightAt(x, z) {
        const broad = trigonometryFreeGradientNoise(x * featureScalePerMetre, z * featureScalePerMetre) * 0.7
            + trigonometryFreeGradientNoise(x * featureScalePerMetre * 2.7 + 5.1, z * featureScalePerMetre * 2.7 + 1.7) * 0.3;
        return waterLevelMetres - (meanDepthMetres + depthVariationMetres * broad);
    };
}
