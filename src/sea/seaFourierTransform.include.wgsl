/*
 * Derived from web-ocean by Maksymilian Dendura (Noniv): https://github.com/Noniv/web-ocean
 * Copyright (c) 2026 Maksymilian Dendura. MIT License; full text in LICENSE.
 */

const FOURIER_GRID: u32 = 256u;
const FOURIER_GRID_LOG2: u32 = 8u;
const FOURIER_PI: f32 = 3.14159265358979;

var<workgroup> workgroupLineA: array<vec4f, 256>;
var<workgroup> workgroupLineB: array<vec4f, 256>;

fn fourierComplexMultiply(first: vec2f, second: vec2f) -> vec2f {
    return vec2f(first.x * second.x - first.y * second.y, first.x * second.y + first.y * second.x);
}

fn bitReversedIndex(index: u32) -> u32 {
    return reverseBits(index) >> (32u - FOURIER_GRID_LOG2);
}

fn inverseButterflies(thread: u32) {
    for (var stage = 0u; stage < FOURIER_GRID_LOG2; stage++) {
        let halfSpan = 1u << stage;
        let position = thread & (halfSpan - 1u);
        let firstIndex = ((thread >> stage) << (stage + 1u)) + position;
        let secondIndex = firstIndex + halfSpan;
        let angle = FOURIER_PI * f32(position) / f32(halfSpan);
        let twiddle = vec2f(cos(angle), sin(angle));
        let firstA = workgroupLineA[firstIndex];
        let secondA = workgroupLineA[secondIndex];
        let firstB = workgroupLineB[firstIndex];
        let secondB = workgroupLineB[secondIndex];
        let rotatedA = vec4f(fourierComplexMultiply(secondA.xy, twiddle), fourierComplexMultiply(secondA.zw, twiddle));
        let rotatedB = vec4f(fourierComplexMultiply(secondB.xy, twiddle), fourierComplexMultiply(secondB.zw, twiddle));
        workgroupLineA[firstIndex] = firstA + rotatedA;
        workgroupLineA[secondIndex] = firstA - rotatedA;
        workgroupLineB[firstIndex] = firstB + rotatedB;
        workgroupLineB[secondIndex] = firstB - rotatedB;
        workgroupBarrier();
    }
}
