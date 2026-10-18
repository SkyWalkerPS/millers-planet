/*
 * Derived from web-ocean by Maksymilian Dendura (Noniv): https://github.com/Noniv/web-ocean
 * Copyright (c) 2026 Maksymilian Dendura. MIT License; full text in LICENSE.
 */

#include<seaFourierTransform>

@group(0) @binding(0) var<storage, read> inputA: array<vec4f>;
@group(0) @binding(1) var<storage, read> inputB: array<vec4f>;
@group(0) @binding(2) var displacementOutput: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(3) var derivativeOutput: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(4) var momentOutput: texture_storage_2d_array<rgba16float, write>;

fn emit(column: u32, row: u32, cascade: u32, first: vec4f, second: vec4f) {
    let texel = vec2u(column, row);
    textureStore(displacementOutput, texel, cascade, vec4f(first.x, first.z, first.y, first.w));
    textureStore(derivativeOutput, texel, cascade, second);
    textureStore(momentOutput, texel, cascade, vec4f(second.x * second.x, second.y * second.y, second.x * second.y, 0.0));
}

@compute @workgroup_size(128)
fn main(@builtin(workgroup_id) workgroup: vec3u, @builtin(local_invocation_index) thread: u32) {
    let column = workgroup.x;
    let cascade = workgroup.z;
    let firstElement = thread;
    let secondElement = thread + FOURIER_GRID / 2u;
    let firstIndex = (cascade * FOURIER_GRID + firstElement) * FOURIER_GRID + column;
    let secondIndex = (cascade * FOURIER_GRID + secondElement) * FOURIER_GRID + column;
    workgroupLineA[bitReversedIndex(firstElement)] = inputA[firstIndex];
    workgroupLineA[bitReversedIndex(secondElement)] = inputA[secondIndex];
    workgroupLineB[bitReversedIndex(firstElement)] = inputB[firstIndex];
    workgroupLineB[bitReversedIndex(secondElement)] = inputB[secondIndex];
    workgroupBarrier();
    inverseButterflies(thread);
    emit(column, firstElement, cascade, workgroupLineA[firstElement], workgroupLineB[firstElement]);
    emit(column, secondElement, cascade, workgroupLineA[secondElement], workgroupLineB[secondElement]);
}
