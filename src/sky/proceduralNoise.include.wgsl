/*
 * Derived from web-ocean by Maksymilian Dendura (Noniv): https://github.com/Noniv/web-ocean
 * Copyright (c) 2026 Maksymilian Dendura. MIT License; full text in LICENSE.
 */

fn permutedCongruentialHash(value: u32) -> u32 {
    let state = value * 747796405u + 2891336453u;
    let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
    return (word >> 22u) ^ word;
}

fn latticeGradientTwo(cell: vec2i) -> vec2f {
    let hashed = permutedCongruentialHash((bitcast<u32>(cell.x) * 0x8da6b343u) ^ (bitcast<u32>(cell.y) * 0xd8163841u));
    let angle = f32(hashed >> 8u) * (6.28318530718 / 16777216.0);
    return vec2f(cos(angle), sin(angle));
}

fn gradientNoiseTwo(position: vec2f) -> f32 {
    let cellFloor = floor(position);
    let local = position - cellFloor;
    let cell = vec2i(cellFloor);
    let fade = local * local * local * (local * (local * 6.0 - 15.0) + 10.0);
    let a = dot(latticeGradientTwo(cell), local);
    let b = dot(latticeGradientTwo(cell + vec2i(1, 0)), local - vec2f(1.0, 0.0));
    let c = dot(latticeGradientTwo(cell + vec2i(0, 1)), local - vec2f(0.0, 1.0));
    let d = dot(latticeGradientTwo(cell + vec2i(1, 1)), local - vec2f(1.0, 1.0));
    return 1.414 * mix(mix(a, b, fade.x), mix(c, d, fade.x), fade.y);
}

fn latticeGradientFromHashBitsTwo(cell: vec2i) -> vec2f {
    let hashed = permutedCongruentialHash((bitcast<u32>(cell.x) * 0x8da6b343u) ^ (bitcast<u32>(cell.y) * 0xd8163841u));
    return vec2f(f32(hashed & 0xffffu), f32(hashed >> 16u)) * (2.0 / 65535.0) - 1.0;
}

fn trigonometryFreeGradientNoiseTwo(position: vec2f) -> f32 {
    let cellFloor = floor(position);
    let local = position - cellFloor;
    let cell = vec2i(cellFloor);
    let fade = local * local * local * (local * (local * 6.0 - 15.0) + 10.0);
    let a = dot(latticeGradientFromHashBitsTwo(cell), local);
    let b = dot(latticeGradientFromHashBitsTwo(cell + vec2i(1, 0)), local - vec2f(1.0, 0.0));
    let c = dot(latticeGradientFromHashBitsTwo(cell + vec2i(0, 1)), local - vec2f(0.0, 1.0));
    let d = dot(latticeGradientFromHashBitsTwo(cell + vec2i(1, 1)), local - vec2f(1.0, 1.0));
    return 1.73 * mix(mix(a, b, fade.x), mix(c, d, fade.x), fade.y);
}

fn fractalNoiseTwo(position: vec2f, octaves: i32, billow: f32) -> f32 {
    var sum = 0.0;
    var amplitude = 0.5;
    var point = position;
    let rotation = mat2x2f(0.8, 0.6, -0.6, 0.8);
    for (var octave = 0; octave < octaves; octave++) {
        var value = gradientNoiseTwo(point);
        if (octave >= 2) {
            value = mix(value, abs(value) * 2.0 - 0.38, billow);
        }
        sum += amplitude * value;
        point = rotation * point * 2.03 + vec2f(13.1, 7.7);
        amplitude *= 0.5;
    }
    return sum;
}

fn latticeOffsetTwo(cell: vec2i) -> vec2f {
    let hashed = permutedCongruentialHash((bitcast<u32>(cell.x) * 0x2c1b3c6du) ^ (bitcast<u32>(cell.y) * 0x297a2d39u));
    let second = permutedCongruentialHash(hashed ^ 0x68e31da4u);
    return vec2f(f32(hashed >> 8u), f32(second >> 8u)) * (1.0 / 16777216.0);
}

fn cellularNearestDistance(position: vec2f) -> f32 {
    let cellFloor = floor(position);
    let local = position - cellFloor;
    let cell = vec2i(cellFloor);
    var nearest = 8.0;
    for (var row = -1; row <= 1; row++) {
        for (var column = -1; column <= 1; column++) {
            let neighbour = vec2i(column, row);
            let featurePoint = vec2f(neighbour) + latticeOffsetTwo(cell + neighbour) * 0.8 + 0.1;
            nearest = min(nearest, length(featurePoint - local));
        }
    }
    return nearest;
}
