/*
 * Derived from web-ocean by Maksymilian Dendura (Noniv): https://github.com/Noniv/web-ocean
 * Copyright (c) 2026 Maksymilian Dendura. MIT License; full text in LICENSE.
 */

varying vUV: vec2f;

var lowerLevelTexture: texture_2d<f32>;
var lowerLevelTextureSampler: sampler;
var sameLevelTexture: texture_2d<f32>;
var sameLevelTextureSampler: sampler;

uniform lowerLevelTexelSize: vec2f;
uniform radius: f32;

fn tapLower(uv: vec2f) -> vec3f {
    return textureSampleLevel(lowerLevelTexture, lowerLevelTextureSampler, uv, 0.0).rgb;
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let offset = uniforms.lowerLevelTexelSize * uniforms.radius;
    let uv = input.vUV;
    var tent = tapLower(uv) * 4.0;
    tent += (tapLower(uv + vec2f(-offset.x, 0.0)) + tapLower(uv + vec2f(offset.x, 0.0)) + tapLower(uv + vec2f(0.0, -offset.y)) + tapLower(uv + vec2f(0.0, offset.y))) * 2.0;
    tent += tapLower(uv + vec2f(-offset.x, -offset.y)) + tapLower(uv + vec2f(offset.x, -offset.y)) + tapLower(uv + vec2f(-offset.x, offset.y)) + tapLower(uv + vec2f(offset.x, offset.y));
    let sameLevel = textureSampleLevel(sameLevelTexture, sameLevelTextureSampler, uv, 0.0).rgb;
    fragmentOutputs.color = vec4f(sameLevel + tent / 16.0, 1.0);
}
