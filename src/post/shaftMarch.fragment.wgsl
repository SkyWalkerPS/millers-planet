/*
 * Derived from snowflow_demo by Maksymilian Dendura (Noniv): https://github.com/Noniv/snowflow_demo
 * Copyright (c) 2026 Maksymilian Dendura. MIT License; full text in LICENSE.
 */

varying vUV: vec2f;

var shaftMaskTexture: texture_2d<f32>;
var shaftMaskTextureSampler: sampler;

uniform lightUv: vec2f;
uniform lightOnScreen: f32;
uniform shaftColour: vec3f;
uniform strength: f32;
uniform aspect: f32;
uniform frameIndex: f32;

const MARCH_STEPS: i32 = 24;
const MARCH_REACH: f32 = 0.82;
const MARCH_DECAY: f32 = 0.955;

fn interleavedGradientNoise(pixel: vec2f, frame: f32) -> f32 {
    let shifted = pixel + frame * vec2f(5.588238, 5.588238);
    return fract(52.9829189 * fract(dot(shifted, vec2f(0.06711056, 0.00583715))));
}

fn marchTowardsLight(uv: vec2f, pixel: vec2f, radialFalloff: f32) -> f32 {
    let step = (uniforms.lightUv - uv) * (MARCH_REACH / f32(MARCH_STEPS));
    var position = uv + step * interleavedGradientNoise(pixel, uniforms.frameIndex);
    var illumination = 1.0;
    var accumulated = 0.0;
    for (var stepIndex = 0; stepIndex < MARCH_STEPS; stepIndex++) {
        accumulated += textureSampleLevel(shaftMaskTexture, shaftMaskTextureSampler, position, 0.0).r * illumination;
        illumination *= MARCH_DECAY;
        position += step;
    }
    accumulated /= f32(MARCH_STEPS);
    return accumulated * radialFalloff * uniforms.strength;
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let uv = input.vUV;
    let fromLight = (uv - uniforms.lightUv) * vec2f(uniforms.aspect, 1.0);
    let radialFalloff = 1.0 - smoothstep(0.03, 0.9, length(fromLight));
    var shaft = 0.0;
    if (uniforms.lightOnScreen > 0.5 && radialFalloff > 0.001) {
        shaft = marchTowardsLight(uv, input.position.xy, radialFalloff);
    }
    fragmentOutputs.color = vec4f(uniforms.shaftColour * shaft, 1.0);
}
