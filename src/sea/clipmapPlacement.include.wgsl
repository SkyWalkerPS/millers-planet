/*
 * Derived from snowflow_demo by Maksymilian Dendura (Noniv): https://github.com/Noniv/snowflow_demo
 * Copyright (c) 2026 Maksymilian Dendura. MIT License; full text in LICENSE.
 */

struct ClipmapVertex {
    worldXZ: vec2f,
    spacing: f32,
    morph: f32,
};

fn placeClipmapVertex(grid: vec2f, ring: f32, centreXZ: vec2f, baseSpacing: f32, gridHalfCount: f32) -> ClipmapVertex {
    let spacing = baseSpacing * exp2(ring);
    let snap = spacing * 2.0;
    let origin = floor(centreXZ / snap) * snap;
    var local = grid * spacing;
    let extent = gridHalfCount * spacing;
    let chebyshev = max(abs(local.x), abs(local.y)) / extent;
    let morph = clamp((chebyshev - 0.70) / 0.16, 0.0, 1.0);
    let coarseGrid = floor(grid * 0.5) * 2.0;
    local = mix(local, coarseGrid * spacing, morph);
    var placed: ClipmapVertex;
    placed.worldXZ = origin + local;
    placed.spacing = spacing * (1.0 + morph);
    placed.morph = morph;
    return placed;
}
