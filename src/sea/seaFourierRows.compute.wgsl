/*
 * Derived from web-ocean by Maksymilian Dendura (Noniv): https://github.com/Noniv/web-ocean
 * Copyright (c) 2026 Maksymilian Dendura. MIT License; full text in LICENSE.
 */

#include<seaFourierTransform>

@group(0) @binding(0) var<storage, read> inputA: array<vec4f>;
@group(0) @binding(1) var<storage, read> inputB: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> outputA: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> outputB: array<vec4f>;

@compute @workgroup_size(128)
fn main(@builtin(workgroup_id) workgroup: vec3u, @builtin(local_invocation_index) thread: u32) {
    let base = (workgroup.z * FOURIER_GRID + workgroup.x) * FOURIER_GRID;
    let firstElement = thread;
    let secondElement = thread + FOURIER_GRID / 2u;
    workgroupLineA[bitReversedIndex(firstElement)] = inputA[base + firstElement];
    workgroupLineA[bitReversedIndex(secondElement)] = inputA[base + secondElement];
    workgroupLineB[bitReversedIndex(firstElement)] = inputB[base + firstElement];
    workgroupLineB[bitReversedIndex(secondElement)] = inputB[base + secondElement];
    workgroupBarrier();
    inverseButterflies(thread);
    outputA[base + firstElement] = workgroupLineA[firstElement];
    outputA[base + secondElement] = workgroupLineA[secondElement];
    outputB[base + firstElement] = workgroupLineB[firstElement];
    outputB[base + secondElement] = workgroupLineB[secondElement];
}
