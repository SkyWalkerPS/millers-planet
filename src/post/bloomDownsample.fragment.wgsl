/*
 * Derived from web-ocean by Maksymilian Dendura (Noniv): https://github.com/Noniv/web-ocean
 * Copyright (c) 2026 Maksymilian Dendura. MIT License; full text in LICENSE.
 */

varying vUV: vec2f;

var sourceTexture: texture_2d<f32>;
var sourceTextureSampler: sampler;

uniform sourceTexelSize: vec2f;
uniform isFirstLevel: f32;

fn luminanceOf(colour: vec3f) -> f32 {
    return dot(colour, vec3f(0.2126, 0.7152, 0.0722));
}

fn tap(uv: vec2f) -> vec3f {
    return textureSampleLevel(sourceTexture, sourceTextureSampler, uv, 0.0).rgb;
}

fn karisWeight(colour: vec3f) -> f32 {
    return 1.0 / (1.0 + luminanceOf(colour) * 0.25);
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let texel = uniforms.sourceTexelSize;
    let uv = input.vUV;
    let a = tap(uv + texel * vec2f(-2.0, -2.0));
    let b = tap(uv + texel * vec2f(0.0, -2.0));
    let c = tap(uv + texel * vec2f(2.0, -2.0));
    let d = tap(uv + texel * vec2f(-2.0, 0.0));
    let e = tap(uv);
    let f = tap(uv + texel * vec2f(2.0, 0.0));
    let g = tap(uv + texel * vec2f(-2.0, 2.0));
    let h = tap(uv + texel * vec2f(0.0, 2.0));
    let i = tap(uv + texel * vec2f(2.0, 2.0));
    let j = tap(uv + texel * vec2f(-1.0, -1.0));
    let k = tap(uv + texel * vec2f(1.0, -1.0));
    let l = tap(uv + texel * vec2f(-1.0, 1.0));
    let m = tap(uv + texel * vec2f(1.0, 1.0));
    var result: vec3f;
    if (uniforms.isFirstLevel > 0.5) {
        let group0 = (a + b + d + e) * 0.25;
        let group1 = (b + c + e + f) * 0.25;
        let group2 = (d + e + g + h) * 0.25;
        let group3 = (e + f + h + i) * 0.25;
        let group4 = (j + k + l + m) * 0.25;
        let weight0 = karisWeight(group0) * 0.125;
        let weight1 = karisWeight(group1) * 0.125;
        let weight2 = karisWeight(group2) * 0.125;
        let weight3 = karisWeight(group3) * 0.125;
        let weight4 = karisWeight(group4) * 0.5;
        result = (group0 * weight0 + group1 * weight1 + group2 * weight2 + group3 * weight3 + group4 * weight4) / (weight0 + weight1 + weight2 + weight3 + weight4);
    } else {
        result = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
    }
    fragmentOutputs.color = vec4f(min(result, vec3f(60000.0)), 1.0);
}
