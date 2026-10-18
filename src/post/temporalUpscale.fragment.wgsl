/*
 * Derived from snowflow_demo by Maksymilian Dendura (Noniv): https://github.com/Noniv/snowflow_demo
 * Copyright (c) 2026 Maksymilian Dendura. MIT License; full text in LICENSE.
 */

varying vUV: vec2f;

var beautyColour: texture_2d<f32>;
var beautyColourSampler: sampler;
var beautyMotion: texture_2d<f32>;
var beautyMotionSampler: sampler;
var historyColour: texture_2d<f32>;
var historyColourSampler: sampler;

uniform internalSize: vec2f;
uniform outputSize: vec2f;
uniform jitterNdc: vec2f;
uniform historyValid: f32;
uniform feedback: f32;
uniform enabled: f32;

fn luminanceOf(colour: vec3f) -> f32 {
    return dot(colour, vec3f(0.2126, 0.7152, 0.0722));
}

fn compressForBlending(colour: vec3f) -> vec3f {
    return colour / (1.0 + luminanceOf(colour));
}

fn expandAfterBlending(colour: vec3f) -> vec3f {
    return colour / max(1e-4, 1.0 - luminanceOf(colour));
}

fn historyCatmullRom(uv: vec2f) -> vec3f {
    let samplePosition = uv * uniforms.outputSize;
    let centreOfFirstTexel = floor(samplePosition - 0.5) + 0.5;
    let fraction = samplePosition - centreOfFirstTexel;
    let weight0 = fraction * (-0.5 + fraction * (1.0 - 0.5 * fraction));
    let weight1 = 1.0 + fraction * fraction * (-2.5 + 1.5 * fraction);
    let weight2 = fraction * (0.5 + fraction * (2.0 - 1.5 * fraction));
    let weight3 = fraction * fraction * (-0.5 + 0.5 * fraction);
    let weight12 = weight1 + weight2;
    let offset12 = weight2 / weight12;
    let position0 = (centreOfFirstTexel - 1.0) / uniforms.outputSize;
    let position3 = (centreOfFirstTexel + 2.0) / uniforms.outputSize;
    let position12 = (centreOfFirstTexel + offset12) / uniforms.outputSize;
    var accumulated = vec3f(0.0);
    accumulated += textureSampleLevel(historyColour, historyColourSampler, vec2f(position12.x, position0.y), 0.0).rgb * (weight12.x * weight0.y);
    accumulated += textureSampleLevel(historyColour, historyColourSampler, vec2f(position0.x, position12.y), 0.0).rgb * (weight0.x * weight12.y);
    accumulated += textureSampleLevel(historyColour, historyColourSampler, vec2f(position12.x, position12.y), 0.0).rgb * (weight12.x * weight12.y);
    accumulated += textureSampleLevel(historyColour, historyColourSampler, vec2f(position3.x, position12.y), 0.0).rgb * (weight3.x * weight12.y);
    accumulated += textureSampleLevel(historyColour, historyColourSampler, vec2f(position12.x, position3.y), 0.0).rgb * (weight12.x * weight3.y);
    let weightTotal = weight12.x * weight0.y + weight0.x * weight12.y + weight12.x * weight12.y + weight3.x * weight12.y + weight12.x * weight3.y;
    return max(accumulated / max(weightTotal, 1e-4), vec3f(0.0));
}

fn closestSurfaceMotion(centreTexel: vec2i, maximumTexel: vec2i) -> vec2f {
    var bestMotion = textureLoad(beautyMotion, centreTexel, 0);
    for (var cornerIndex = 0; cornerIndex < 4; cornerIndex++) {
        let corner = vec2i(select(-1, 1, (cornerIndex & 1) == 1), select(-1, 1, (cornerIndex & 2) == 2));
        let candidate = textureLoad(beautyMotion, clamp(centreTexel + corner, vec2i(0), maximumTexel), 0);
        if (candidate.z < bestMotion.z) {
            bestMotion = candidate;
        }
    }
    return bestMotion.xy;
}

fn resolveOutputPixel(outputUv: vec2f) -> vec3f {
    let jitterUv = uniforms.jitterNdc * 0.5;
    let internalPixelPosition = (outputUv + jitterUv) * uniforms.internalSize;
    let nearestTexel = vec2i(floor(internalPixelPosition));
    let maximumTexel = vec2i(uniforms.internalSize) - vec2i(1);
    var weightedColour = vec3f(0.0);
    var weightTotal = 0.0;
    var nearestWeight = 0.0;
    var firstMoment = vec3f(0.0);
    var secondMoment = vec3f(0.0);
    for (var offsetY = -1; offsetY <= 1; offsetY++) {
        for (var offsetX = -1; offsetX <= 1; offsetX++) {
            let texel = clamp(nearestTexel + vec2i(offsetX, offsetY), vec2i(0), maximumTexel);
            let sampleColour = compressForBlending(textureLoad(beautyColour, texel, 0).rgb);
            let offsetInPixels = vec2f(texel) + 0.5 - internalPixelPosition;
            let weight = exp(-2.29 * dot(offsetInPixels, offsetInPixels));
            weightedColour += sampleColour * weight;
            weightTotal += weight;
            nearestWeight = max(nearestWeight, weight);
            firstMoment += sampleColour;
            secondMoment += sampleColour * sampleColour;
        }
    }
    let current = weightedColour / max(weightTotal, 1e-5);
    if (uniforms.enabled < 0.5 || uniforms.historyValid < 0.5) {
        return expandAfterBlending(current);
    }
    let motion = closestSurfaceMotion(clamp(nearestTexel, vec2i(0), maximumTexel), maximumTexel);
    let previousUv = outputUv - motion;
    if (any(previousUv < vec2f(0.0)) || any(previousUv > vec2f(1.0))) {
        return expandAfterBlending(current);
    }
    let mean = firstMoment / 9.0;
    let deviation = sqrt(max(vec3f(0.0), secondMoment / 9.0 - mean * mean));
    let lowerBound = mean - deviation * 1.25;
    let upperBound = mean + deviation * 1.25;
    var rawHistory = compressForBlending(historyCatmullRom(previousUv));
    if (any(rawHistory != rawHistory)) {
        rawHistory = current;
    }
    let clippedHistory = clamp(rawHistory, lowerBound, upperBound);
    let travelInOutputPixels = length(motion * uniforms.outputSize);
    let motionFade = 1.0 - clamp(travelInOutputPixels / 64.0, 0.0, 1.0) * 0.35;
    let clipFade = 1.0 - clamp(length(clippedHistory - rawHistory) * 4.0, 0.0, 1.0) * 0.45;
    let historyWeight = clamp(uniforms.feedback * motionFade * clipFade, 0.0, 0.97);
    let currentWeight = (1.0 - historyWeight) * mix(0.3, 1.0, nearestWeight);
    return expandAfterBlending(mix(clippedHistory, current, currentWeight));
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    fragmentOutputs.color = vec4f(resolveOutputPixel(input.vUV), 1.0);
}
