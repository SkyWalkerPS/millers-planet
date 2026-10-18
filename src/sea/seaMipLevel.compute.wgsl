/*
 * Derived from web-ocean by Maksymilian Dendura (Noniv): https://github.com/Noniv/web-ocean
 * Copyright (c) 2026 Maksymilian Dendura. MIT License; full text in LICENSE.
 */

@group(0) @binding(0) var sourceDisplacement: texture_2d_array<f32>;
@group(0) @binding(1) var sourceDerivatives: texture_2d_array<f32>;
@group(0) @binding(2) var sourceMoments: texture_2d_array<f32>;
@group(0) @binding(3) var destinationDisplacement: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(4) var destinationDerivatives: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(5) var destinationMoments: texture_storage_2d_array<rgba16float, write>;

fn boxAverage(source: texture_2d_array<f32>, corner: vec2i, layer: u32) -> vec4f {
    return 0.25 * (textureLoad(source, corner, layer, 0) + textureLoad(source, corner + vec2i(1, 0), layer, 0)
        + textureLoad(source, corner + vec2i(0, 1), layer, 0) + textureLoad(source, corner + vec2i(1, 1), layer, 0));
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) invocation: vec3u) {
    let size = textureDimensions(destinationDisplacement);
    if (invocation.x >= size.x || invocation.y >= size.y) {
        return;
    }
    let corner = vec2i(invocation.xy) * 2;
    textureStore(destinationDisplacement, invocation.xy, invocation.z, boxAverage(sourceDisplacement, corner, invocation.z));
    textureStore(destinationDerivatives, invocation.xy, invocation.z, boxAverage(sourceDerivatives, corner, invocation.z));
    textureStore(destinationMoments, invocation.xy, invocation.z, boxAverage(sourceMoments, corner, invocation.z));
}
