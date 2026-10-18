/*
 * Derived from web-ocean by Maksymilian Dendura (Noniv): https://github.com/Noniv/web-ocean
 * Copyright (c) 2026 Maksymilian Dendura. MIT License; full text in LICENSE.
 */

const SEA_GRID: u32 = 256u;
const SEA_GRID_LOG2: u32 = 8u;
const SEA_PI: f32 = 3.14159265358979;

struct SeaSimulationParameters {
    cascadeSizes: vec4f,
    cascadeMinimumWavenumbers: vec4f,
    cascadeMaximumWavenumbers: vec4f,
    cascadeGains: vec4f,
    windSpeedPeakGammaAlpha: vec4f,
    windDirectionAndUnused: vec4f,
    choppinessCutLoopSeed: vec4f,
    timeDeltaUnusedGain: vec4f,
    depthGravityCapSurfaceTension: vec4f,
    testModeCascadeIndexAmplitude: vec4f,
};

fn cascadeComponent(values: vec4f, cascade: u32) -> f32 {
    return values[cascade];
}

fn waveVector(column: u32, row: u32, patchSize: f32) -> vec2f {
    let indexX = select(i32(column), i32(column) - i32(SEA_GRID), column >= SEA_GRID / 2u);
    let indexZ = select(i32(row), i32(row) - i32(SEA_GRID), row >= SEA_GRID / 2u);
    return vec2f(f32(indexX), f32(indexZ)) * (2.0 * SEA_PI / patchSize);
}

fn depthTanh(wavenumber: f32, parameters: SeaSimulationParameters) -> f32 {
    return tanh(min(wavenumber * parameters.depthGravityCapSurfaceTension.x, 10.0));
}

fn angularFrequency(wavenumber: f32, parameters: SeaSimulationParameters) -> f32 {
    let gravity = parameters.depthGravityCapSurfaceTension.y;
    let surfaceTension = parameters.depthGravityCapSurfaceTension.w;
    return sqrt((gravity * wavenumber + surfaceTension * wavenumber * wavenumber * wavenumber) * depthTanh(wavenumber, parameters));
}

fn angularFrequencySlope(wavenumber: f32, parameters: SeaSimulationParameters) -> f32 {
    let depth = parameters.depthGravityCapSurfaceTension.x;
    let gravity = parameters.depthGravityCapSurfaceTension.y;
    let surfaceTension = parameters.depthGravityCapSurfaceTension.w;
    let tanhValue = depthTanh(wavenumber, parameters);
    let sechSquared = 1.0 - tanhValue * tanhValue;
    let restoring = gravity * wavenumber + surfaceTension * wavenumber * wavenumber * wavenumber;
    let frequency = max(angularFrequency(wavenumber, parameters), 1e-6);
    return ((gravity + 3.0 * surfaceTension * wavenumber * wavenumber) * tanhValue + restoring * depth * sechSquared) / (2.0 * frequency);
}

fn complexMultiply(first: vec2f, second: vec2f) -> vec2f {
    return vec2f(first.x * second.x - first.y * second.y, first.x * second.y + first.y * second.x);
}

fn multiplyByImaginaryUnit(value: vec2f) -> vec2f {
    return vec2f(-value.y, value.x);
}
