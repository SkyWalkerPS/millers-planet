#include<beautyOutputs>

varying vUV: vec2f;

var beautyColour: texture_2d<f32>;
var beautyColourSampler: sampler;
var beautyMotion: texture_2d<f32>;
var beautyMotionSampler: sampler;

uniform subRectangleUvScale: vec2f;
uniform internalTexelSize: vec2f;
uniform brightnessCeiling: f32;

fn skyBrightnessAt(uv: vec2f) -> f32 {
    let surface = textureSampleLevel(beautyMotion, beautyMotionSampler, uv, 0.0).w;
    if (surface > SURFACE_CODE_SKY + 0.5) {
        return 0.0;
    }
    let colour = textureSampleLevel(beautyColour, beautyColourSampler, uv, 0.0).rgb;
    return min(dot(colour, vec3f(0.2126, 0.7152, 0.0722)), uniforms.brightnessCeiling);
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let centre = input.vUV * uniforms.subRectangleUvScale;
    let spread = uniforms.internalTexelSize * 1.5;
    let brightness = 0.25 * (skyBrightnessAt(centre + vec2f(-spread.x, -spread.y)) + skyBrightnessAt(centre + vec2f(spread.x, -spread.y)) + skyBrightnessAt(centre + vec2f(-spread.x, spread.y)) + skyBrightnessAt(centre + vec2f(spread.x, spread.y)));
    fragmentOutputs.color = vec4f(brightness, 0.0, 0.0, 1.0);
}
