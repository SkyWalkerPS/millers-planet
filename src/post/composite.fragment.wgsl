/*
 * Derived from snowflow_demo by Maksymilian Dendura (Noniv): https://github.com/Noniv/snowflow_demo
 * Derived from web-ocean by Maksymilian Dendura (Noniv): https://github.com/Noniv/web-ocean
 * Copyright (c) 2026 Maksymilian Dendura. MIT License; full text in LICENSE.
 */

varying vUV: vec2f;

var resolvedColour: texture_2d<f32>;
var resolvedColourSampler: sampler;
var bloomTexture: texture_2d<f32>;
var bloomTextureSampler: sampler;
var shaftTexture: texture_2d<f32>;
var shaftTextureSampler: sampler;
var beautyMotion: texture_2d<f32>;
var beautyMotionSampler: sampler;

uniform outputTexelSize: vec2f;
uniform subRectangleUvScale: vec2f;
uniform exposure: f32;
uniform bloomAmount: f32;
uniform shaftAmount: f32;
uniform vignetteAmount: f32;
uniform grainAmount: f32;
uniform sharpenAmount: f32;
uniform focusDistanceMetres: f32;
uniform maximumBlurRadiusPixels: f32;
uniform helmetRimAmount: f32;
uniform frameIndex: f32;
uniform aspect: f32;
uniform outputBlack: f32;
uniform shadowColourBalance: vec3f;
uniform shadowBalanceLumaRange: vec2f;
uniform waterCrossingAmount: f32;

const AGX_INSET = mat3x3f(
    0.842479062253094, 0.0423282422610123, 0.0423756549057051,
    0.0784335999999992, 0.878468636469772, 0.0784336,
    0.0792237451477643, 0.0791661274605434, 0.879142973793104
);

const AGX_OUTSET = mat3x3f(
    1.19687900512017, -0.0528968517574562, -0.0529716355144438,
    -0.0980208811401368, 1.15190312990417, -0.0980434501171241,
    -0.0990297440797205, -0.0989611768448433, 1.15107367264116
);

const BLUR_TAP_COUNT: i32 = 16;
const GOLDEN_ANGLE: f32 = 2.39996323;

fn agxContrastCurve(x: vec3f) -> vec3f {
    let x2 = x * x;
    let x4 = x2 * x2;
    return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

fn agxToDisplay(sceneLinear: vec3f) -> vec3f {
    let minimumExposureValue = -12.47393;
    let maximumExposureValue = 4.026069;
    var encoded = AGX_INSET * max(sceneLinear, vec3f(1e-10));
    encoded = clamp(log2(encoded), vec3f(minimumExposureValue), vec3f(maximumExposureValue));
    encoded = (encoded - minimumExposureValue) / (maximumExposureValue - minimumExposureValue);
    var display = agxContrastCurve(encoded);
    let luminance = dot(display, vec3f(0.2126, 0.7152, 0.0722));
    display = luminance + 1.06 * (pow(max(display, vec3f(0.0)), vec3f(1.04)) - luminance);
    return AGX_OUTSET * display;
}

fn interleavedGradientNoise(pixel: vec2f) -> f32 {
    return fract(52.9829189 * fract(dot(pixel, vec2f(0.06711056, 0.00583715))));
}

fn viewDepthAt(uv: vec2f) -> f32 {
    return textureSampleLevel(beautyMotion, beautyMotionSampler, uv * uniforms.subRectangleUvScale, 0.0).z;
}

fn nearBlurRadius(viewDepth: f32) -> f32 {
    let nearness = smoothstep(uniforms.focusDistanceMetres * 0.55, uniforms.focusDistanceMetres * 0.16, viewDepth);
    return nearness * uniforms.maximumBlurRadiusPixels;
}

fn gatherNearBlur(uv: vec2f, pixel: vec2f, radius: f32, centre: vec3f) -> vec3f {
    let rotation = interleavedGradientNoise(pixel) * 6.28318530718;
    var accumulated = centre;
    var weightTotal = 1.0;
    for (var tapIndex = 0; tapIndex < BLUR_TAP_COUNT; tapIndex++) {
        let tapNumber = f32(tapIndex) + 0.5;
        let angle = rotation + tapNumber * GOLDEN_ANGLE;
        let tapRadius = radius * sqrt(tapNumber / f32(BLUR_TAP_COUNT));
        let tapUv = uv + vec2f(cos(angle), sin(angle)) * tapRadius * uniforms.outputTexelSize;
        let tapBlur = nearBlurRadius(viewDepthAt(tapUv));
        let weight = clamp(tapBlur - tapRadius + 1.0, 0.0, 1.0);
        accumulated += textureSampleLevel(resolvedColour, resolvedColourSampler, tapUv, 0.0).rgb * weight;
        weightTotal += weight;
    }
    return accumulated / weightTotal;
}

fn sharpened(uv: vec2f, centre: vec3f) -> vec3f {
    let texel = uniforms.outputTexelSize;
    let left = textureSampleLevel(resolvedColour, resolvedColourSampler, uv - vec2f(texel.x, 0.0), 0.0).rgb;
    let right = textureSampleLevel(resolvedColour, resolvedColourSampler, uv + vec2f(texel.x, 0.0), 0.0).rgb;
    let below = textureSampleLevel(resolvedColour, resolvedColourSampler, uv - vec2f(0.0, texel.y), 0.0).rgb;
    let above = textureSampleLevel(resolvedColour, resolvedColourSampler, uv + vec2f(0.0, texel.y), 0.0).rgb;
    let lowest = min(centre, min(min(left, right), min(below, above)));
    let highest = max(centre, max(max(left, right), max(below, above)));
    let strength = uniforms.sharpenAmount * 0.32;
    return clamp(centre * (1.0 + 4.0 * strength) - (left + right + below + above) * strength, lowest, highest);
}

fn crossingGradient(cell: vec2f) -> vec2f {
    let wrapped = vec2u(vec2i(cell) & vec2i(1023));
    var state = wrapped.x * 747796405u + wrapped.y * 2891336453u + 277803737u;
    state = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
    state = (state >> 22u) ^ state;
    let angle = f32(state) * (6.2831853 / 4294967295.0);
    return vec2f(cos(angle), sin(angle));
}

fn crossingGradientNoise(point: vec2f) -> f32 {
    let cell = floor(point);
    let local = fract(point);
    let eased = local * local * local * (local * (local * 6.0 - 15.0) + 10.0);
    let bottomLeft = dot(crossingGradient(cell), local);
    let bottomRight = dot(crossingGradient(cell + vec2f(1.0, 0.0)), local - vec2f(1.0, 0.0));
    let topLeft = dot(crossingGradient(cell + vec2f(0.0, 1.0)), local - vec2f(0.0, 1.0));
    let topRight = dot(crossingGradient(cell + vec2f(1.0, 1.0)), local - vec2f(1.0, 1.0));
    return 0.5 + 0.7 * mix(mix(bottomLeft, bottomRight, eased.x), mix(topLeft, topRight, eased.x), eased.y);
}

fn waterCrossingWipe(display: vec3f, uv: vec2f, amount: f32) -> vec3f {
    let seconds = (uniforms.frameIndex % 36000.0) * (1.0 / 60.0);
    let point = vec2f(uv.x * uniforms.aspect, uv.y);
    var churn = crossingGradientNoise(point * 3.0 + vec2f(0.0, seconds * 2.5)) * 0.55;
    churn += crossingGradientNoise(mat2x2f(0.8, -0.6, 0.6, 0.8) * point * 7.0 + vec2f(seconds * 1.3, seconds * 6.0)) * 0.3;
    churn += crossingGradientNoise(mat2x2f(0.6, 0.8, -0.8, 0.6) * point * 17.0 + vec2f(-seconds * 2.0, seconds * 11.0)) * 0.15;
    let foam = smoothstep(0.5, 0.78, churn + 0.12 * amount) * amount;
    let wetTint = display * vec3f(0.62, 0.86, 0.88) + vec3f(0.05, 0.1, 0.11);
    let tinted = mix(display, wetTint, amount * 0.6);
    return mix(tinted, vec3f(0.82, 0.92, 0.91), foam * 0.75);
}

fn helmetRimFactor(uv: vec2f) -> f32 {
    let fromCentre = (uv - vec2f(0.5)) * vec2f(uniforms.aspect, 1.0);
    let normalisedRadius = length(fromCentre) / (0.5 * sqrt(uniforms.aspect * uniforms.aspect + 1.0));
    return smoothstep(0.78, 1.02, normalisedRadius);
}

fn displayColour(uv: vec2f, pixel: vec2f) -> vec3f {
    var colour = textureSampleLevel(resolvedColour, resolvedColourSampler, uv, 0.0).rgb;
    let blurRadius = nearBlurRadius(viewDepthAt(uv));
    if (blurRadius >= 1.5) {
        colour = gatherNearBlur(uv, pixel, blurRadius, colour);
    } else if (uniforms.sharpenAmount > 0.001) {
        colour = sharpened(uv, colour);
    }
    colour += textureSampleLevel(shaftTexture, shaftTextureSampler, uv, 0.0).rgb * uniforms.shaftAmount;
    let bloom = textureSampleLevel(bloomTexture, bloomTextureSampler, uv, 0.0).rgb * (1.0 / 8.0);
    colour = mix(colour, bloom, uniforms.bloomAmount);
    colour *= uniforms.exposure;
    let fromCentre = (uv - vec2f(0.5)) * vec2f(uniforms.aspect, 1.0);
    colour *= 1.0 - uniforms.vignetteAmount * dot(fromCentre, fromCentre);
    var display = agxToDisplay(colour);
    let displayLuma = dot(display, vec3f(0.2126, 0.7152, 0.0722));
    display *= mix(uniforms.shadowColourBalance, vec3f(1.0), smoothstep(uniforms.shadowBalanceLumaRange.x, uniforms.shadowBalanceLumaRange.y, displayLuma));
    let rim = helmetRimFactor(uv) * uniforms.helmetRimAmount;
    display = mix(display, display * 0.18 + vec3f(0.035, 0.04, 0.045), rim);
    if (uniforms.waterCrossingAmount > 0.002) {
        display = waterCrossingWipe(display, uv, uniforms.waterCrossingAmount);
    }
    let cell = floor(pixel * 0.5);
    let grain = interleavedGradientNoise(cell + vec2f(uniforms.frameIndex * 7.31, uniforms.frameIndex * 3.17)) - 0.5;
    let dither = (interleavedGradientNoise(pixel + uniforms.frameIndex * 5.588238) + interleavedGradientNoise(pixel * 1.37 + 17.0 + uniforms.frameIndex * 3.1) - 1.0) / 255.0;
    display += grain * uniforms.grainAmount + dither;
    return clamp(display, vec3f(0.0), vec3f(1.0));
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let display = displayColour(input.vUV, input.position.xy);
    fragmentOutputs.color = vec4f(display * (1.0 - uniforms.outputBlack), 1.0);
}
