/*
 * Derived from web-ocean by Maksymilian Dendura (Noniv): https://github.com/Noniv/web-ocean
 * Copyright (c) 2026 Maksymilian Dendura. MIT License; full text in LICENSE.
 */

#include<seaSimulation>

@group(0) @binding(0) var<uniform> simulation: SeaSimulationParameters;
@group(0) @binding(1) var<storage, read> initialSpectrum: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> spectrumA: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> spectrumB: array<vec4f>;

fn depthLimitedChoppiness(wavenumber: f32) -> f32 {
    let kh = max(wavenumber * simulation.depthGravityCapSurfaceTension.x, 1e-3);
    let hyperbolicCotangent = 1.0 / tanh(min(kh, 10.0));
    let capillaryFade = 1.0 - smoothstep(150.0, 364.0, wavenumber);
    return simulation.choppinessCutLoopSeed.x * min(hyperbolicCotangent, simulation.depthGravityCapSurfaceTension.z) * capillaryFade;
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) invocation: vec3u) {
    let cascade = invocation.z;
    let index = (cascade * SEA_GRID + invocation.y) * SEA_GRID + invocation.x;
    let waveVectorValue = waveVector(invocation.x, invocation.y, cascadeComponent(simulation.cascadeSizes, cascade));
    let wavenumber = length(waveVectorValue);
    if (wavenumber < 1e-5) {
        spectrumA[index] = vec4f(0.0);
        spectrumB[index] = vec4f(0.0);
        return;
    }
    let loopFrequency = 2.0 * SEA_PI / simulation.choppinessCutLoopSeed.z;
    let frequency = floor(angularFrequency(wavenumber, simulation) / loopFrequency) * loopFrequency;
    let phase = frequency * simulation.timeDeltaUnusedGain.x;
    let rotation = vec2f(cos(phase), sin(phase));
    let initial = initialSpectrum[index];
    let height = complexMultiply(initial.xy, vec2f(rotation.x, -rotation.y)) + complexMultiply(initial.zw, rotation);
    let heightTimesImaginary = multiplyByImaginaryUnit(height);
    let choppiness = depthLimitedChoppiness(wavenumber);
    let inverseWavenumber = 1.0 / wavenumber;
    let displacementX = heightTimesImaginary * (choppiness * waveVectorValue.x * inverseWavenumber);
    let displacementZ = heightTimesImaginary * (choppiness * waveVectorValue.y * inverseWavenumber);
    let jacobianXZ = height * (-choppiness * waveVectorValue.x * waveVectorValue.y * inverseWavenumber);
    let slopeX = heightTimesImaginary * waveVectorValue.x;
    let slopeZ = heightTimesImaginary * waveVectorValue.y;
    let jacobianXX = height * (-choppiness * waveVectorValue.x * waveVectorValue.x * inverseWavenumber);
    let jacobianZZ = height * (-choppiness * waveVectorValue.y * waveVectorValue.y * inverseWavenumber);
    spectrumA[index] = vec4f(displacementX + multiplyByImaginaryUnit(displacementZ), height + multiplyByImaginaryUnit(jacobianXZ));
    spectrumB[index] = vec4f(slopeX + multiplyByImaginaryUnit(slopeZ), jacobianXX + multiplyByImaginaryUnit(jacobianZZ));
}
