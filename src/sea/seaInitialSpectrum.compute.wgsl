/*
 * Derived from web-ocean by Maksymilian Dendura (Noniv): https://github.com/Noniv/web-ocean
 * Copyright (c) 2026 Maksymilian Dendura. MIT License; full text in LICENSE.
 */

#include<seaSimulation>

@group(0) @binding(0) var<uniform> simulation: SeaSimulationParameters;
@group(0) @binding(1) var<storage, read_write> initialSpectrum: array<vec4f>;

fn permutedCongruentialHash(value: u32) -> u32 {
    let state = value * 747796405u + 2891336453u;
    let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
    return (word >> 22u) ^ word;
}

fn uniformRandom(seed: u32) -> f32 {
    return (f32(permutedCongruentialHash(seed) >> 8u) + 0.5) / 16777216.0;
}

fn gaussianPair(seed: u32) -> vec2f {
    let first = uniformRandom(seed * 2u + 17u);
    let second = uniformRandom(seed * 2u + 18u + permutedCongruentialHash(seed));
    let radius = sqrt(-2.0 * log(first));
    let angle = 2.0 * SEA_PI * second;
    return radius * vec2f(cos(angle), sin(angle));
}

fn wrapAngle(angle: f32) -> f32 {
    return angle - 2.0 * SEA_PI * floor((angle + SEA_PI) / (2.0 * SEA_PI));
}

fn jonswap(frequency: f32, peakFrequency: f32, alpha: f32, gamma: f32, gravity: f32) -> f32 {
    let sigma = select(0.09, 0.07, frequency <= peakFrequency);
    let offset = (frequency - peakFrequency) / (sigma * peakFrequency);
    let peakEnhancement = exp(-0.5 * offset * offset);
    let ratio = peakFrequency / frequency;
    let ratioSquared = ratio * ratio;
    return alpha * gravity * gravity / (frequency * frequency * frequency * frequency * frequency) * exp(-1.25 * ratioSquared * ratioSquared) * pow(gamma, peakEnhancement);
}

fn donelanBanner(angle: f32, frequency: f32, peakFrequency: f32) -> f32 {
    let ratio = frequency / peakFrequency;
    var beta: f32;
    if (ratio < 0.95) {
        beta = 2.61 * pow(ratio, 1.3);
    } else if (ratio < 1.6) {
        beta = 2.28 * pow(ratio, -1.3);
    } else {
        let exponent = -0.4 + 0.8393 * exp(-0.567 * log(ratio * ratio));
        beta = pow(10.0, exponent);
    }
    let hyperbolicSecant = 1.0 / cosh(clamp(beta * angle, -20.0, 20.0));
    return beta / (2.0 * tanh(beta * SEA_PI)) * hyperbolicSecant * hyperbolicSecant;
}

fn tmaDepthFactor(wavenumber: f32) -> f32 {
    let kh = clamp(wavenumber * simulation.depthGravityCapSurfaceTension.x, 1e-4, 10.0);
    let tanhValue = tanh(kh);
    return tanhValue * tanhValue / (1.0 + 2.0 * kh / sinh(2.0 * kh));
}

fn spectrum(waveVectorValue: vec2f) -> f32 {
    let wavenumber = length(waveVectorValue);
    let frequency = angularFrequency(wavenumber, simulation);
    let wind = simulation.windSpeedPeakGammaAlpha;
    if (wind.x < 0.1) {
        return 0.0;
    }
    let windAngle = atan2(simulation.windDirectionAndUnused.y, simulation.windDirectionAndUnused.x);
    let angle = atan2(waveVectorValue.y, waveVectorValue.x);
    let gravity = simulation.depthGravityCapSurfaceTension.y;
    var energy = jonswap(frequency, wind.y, wind.w, wind.z, gravity) * tmaDepthFactor(wavenumber) * donelanBanner(wrapAngle(angle - windAngle), frequency, wind.y);
    let shortWaveCut = simulation.choppinessCutLoopSeed.y;
    energy *= exp(-wavenumber * wavenumber * shortWaveCut * shortWaveCut);
    return energy * angularFrequencySlope(wavenumber, simulation) / wavenumber * simulation.timeDeltaUnusedGain.w;
}

fn modeAmplitude(waveVectorValue: vec2f, cascade: u32) -> f32 {
    let wavenumber = length(waveVectorValue);
    if (wavenumber < 1e-5 || wavenumber < cascadeComponent(simulation.cascadeMinimumWavenumbers, cascade) || wavenumber >= cascadeComponent(simulation.cascadeMaximumWavenumbers, cascade)) {
        return 0.0;
    }
    let wavenumberStep = 2.0 * SEA_PI / cascadeComponent(simulation.cascadeSizes, cascade);
    return sqrt(max(spectrum(waveVectorValue), 0.0)) * wavenumberStep * 0.5 * cascadeComponent(simulation.cascadeGains, cascade);
}

fn testModeEntry(column: u32, row: u32, cascade: u32) -> vec4f {
    let test = simulation.testModeCascadeIndexAmplitude;
    let modeIndex = u32(test.z);
    if (cascade != u32(test.y) || row != 0u) {
        return vec4f(0.0);
    }
    if (column == modeIndex) {
        return vec4f(test.w, 0.0, 0.0, 0.0);
    }
    if (column == SEA_GRID - modeIndex) {
        return vec4f(0.0, 0.0, test.w, 0.0);
    }
    return vec4f(0.0);
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) invocation: vec3u) {
    let cascade = invocation.z;
    let index = (cascade * SEA_GRID + invocation.y) * SEA_GRID + invocation.x;
    if (simulation.testModeCascadeIndexAmplitude.x > 0.5) {
        initialSpectrum[index] = testModeEntry(invocation.x, invocation.y, cascade);
        return;
    }
    let patchSize = cascadeComponent(simulation.cascadeSizes, cascade);
    let waveVectorValue = waveVector(invocation.x, invocation.y, patchSize);
    let mirroredColumn = (SEA_GRID - invocation.x) % SEA_GRID;
    let mirroredRow = (SEA_GRID - invocation.y) % SEA_GRID;
    let seed = u32(simulation.choppinessCutLoopSeed.w) * 7919u + cascade * 1000003u;
    let forward = gaussianPair(seed + (invocation.y * SEA_GRID + invocation.x)) * modeAmplitude(waveVectorValue, cascade);
    let backward = gaussianPair(seed + (mirroredRow * SEA_GRID + mirroredColumn)) * modeAmplitude(-waveVectorValue, cascade);
    initialSpectrum[index] = vec4f(forward, backward.x, -backward.y);
}
