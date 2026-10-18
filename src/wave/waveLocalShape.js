/*
 * Derived from web-ocean by Maksymilian Dendura (Noniv): https://github.com/Noniv/web-ocean
 * Copyright (c) 2026 Maksymilian Dendura. MIT License; full text in LICENSE.
 */

function permutedCongruentialHash(value) {
    const state = (Math.imul(value >>> 0, 747796405) + 2891336453) >>> 0;
    const word = Math.imul(((state >>> (((state >>> 28) + 4) >>> 0)) ^ state) >>> 0, 277803737) >>> 0;
    return ((word >>> 22) ^ word) >>> 0;
}

function latticeGradientFromHashBits(cellX, cellY, out, offset) {
    const hashed = permutedCongruentialHash((Math.imul(cellX >>> 0, 0x8da6b343) ^ Math.imul(cellY >>> 0, 0xd8163841)) >>> 0);
    out[offset] = (hashed & 0xffff) * (2 / 65535) - 1;
    out[offset + 1] = (hashed >>> 16) * (2 / 65535) - 1;
}

const cornerGradients = new Float64Array(8);

export function trigonometryFreeGradientNoiseTwo(x, y) {
    const cellX = Math.floor(x);
    const cellY = Math.floor(y);
    const localX = x - cellX;
    const localY = y - cellY;
    const fadeX = localX * localX * localX * (localX * (localX * 6 - 15) + 10);
    const fadeY = localY * localY * localY * (localY * (localY * 6 - 15) + 10);
    latticeGradientFromHashBits(cellX, cellY, cornerGradients, 0);
    latticeGradientFromHashBits(cellX + 1, cellY, cornerGradients, 2);
    latticeGradientFromHashBits(cellX, cellY + 1, cornerGradients, 4);
    latticeGradientFromHashBits(cellX + 1, cellY + 1, cornerGradients, 6);
    const a = cornerGradients[0] * localX + cornerGradients[1] * localY;
    const b = cornerGradients[2] * (localX - 1) + cornerGradients[3] * localY;
    const c = cornerGradients[4] * localX + cornerGradients[5] * (localY - 1);
    const d = cornerGradients[6] * (localX - 1) + cornerGradients[7] * (localY - 1);
    const bottom = a + (b - a) * fadeX;
    const top = c + (d - c) * fadeX;
    return 1.73 * (bottom + (top - bottom) * fadeY);
}

export function waveLocalShapeAt(absoluteLateralMetres, out) {
    const broad = trigonometryFreeGradientNoiseTwo(absoluteLateralMetres * 0.00055, 4.1);
    const medium = trigonometryFreeGradientNoiseTwo(absoluteLateralMetres * 0.0021, 9.7);
    out.heightScale = 1 + 0.07 * broad + 0.025 * medium;
    out.crestOffsetMetres = 140 * trigonometryFreeGradientNoiseTwo(absoluteLateralMetres * 0.00035, 1.3);
    return out;
}
