/*
 * Derived from web-ocean by Maksymilian Dendura (Noniv): https://github.com/Noniv/web-ocean
 * Copyright (c) 2026 Maksymilian Dendura. MIT License; full text in LICENSE.
 */

#include<atmosphereCore>

@group(0) @binding(0) var<uniform> atmosphere: AtmosphereParameters;
@group(0) @binding(1) var transmittanceLutSampler: sampler;
@group(0) @binding(2) var transmittanceLut: texture_2d<f32>;
@group(0) @binding(3) var multipleScatteringOutput: texture_storage_2d<rgba16float, write>;

fn transmittanceTowards(radius: f32, cosine: f32, parameters: AtmosphereParameters) -> vec3f {
    return textureSampleLevel(transmittanceLut, transmittanceLutSampler, transmittanceRadiusCosineToUv(radius, cosine, parameters), 0.0).rgb;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) invocation: vec3u) {
    if (f32(invocation.x) >= MULTIPLE_SCATTERING_LUT_SIZE || f32(invocation.y) >= MULTIPLE_SCATTERING_LUT_SIZE) {
        return;
    }
    let parameters = atmosphere;
    let ground = groundRadius(parameters);
    let top = topRadius(parameters);
    var uv = (vec2f(invocation.xy) + 0.5) / MULTIPLE_SCATTERING_LUT_SIZE;
    uv = vec2f(subUvToUnit(uv.x, MULTIPLE_SCATTERING_LUT_SIZE), subUvToUnit(uv.y, MULTIPLE_SCATTERING_LUT_SIZE));
    let lightCosine = uv.x * 2.0 - 1.0;
    let height = max(uv.y * (top - ground), 0.01);
    let radius = ground + height;
    let origin = vec3f(0.0, radius, 0.0);
    let lightDirection = vec3f(sqrt(max(0.0, 1.0 - lightCosine * lightCosine)), lightCosine, 0.0);
    var radianceSum = vec3f(0.0);
    var transferSum = vec3f(0.0);
    let directionsPerAxis = 8u;
    let stepCount = 20u;
    for (var azimuthIndex = 0u; azimuthIndex < directionsPerAxis; azimuthIndex++) {
        for (var polarIndex = 0u; polarIndex < directionsPerAxis; polarIndex++) {
            let polar = acos(1.0 - 2.0 * (f32(polarIndex) + 0.5) / f32(directionsPerAxis));
            let azimuth = 2.0 * ATMOSPHERE_PI * (f32(azimuthIndex) + 0.5) / f32(directionsPerAxis);
            let direction = vec3f(sin(polar) * cos(azimuth), cos(polar), sin(polar) * sin(azimuth));
            let topHit = raySphereIntersection(origin, direction, top);
            let groundHit = raySphereIntersection(origin, direction, ground);
            var marchLength = topHit.y;
            let hitsGround = groundHit.x > 0.0;
            if (hitsGround) {
                marchLength = groundHit.x;
            }
            let stepLength = marchLength / f32(stepCount);
            var transmittance = vec3f(1.0);
            var radiance = vec3f(0.0);
            var transfer = vec3f(0.0);
            for (var stepIndex = 0u; stepIndex < stepCount; stepIndex++) {
                let samplePoint = origin + direction * ((f32(stepIndex) + 0.5) * stepLength);
                let sampleRadius = length(samplePoint);
                let medium = atmosphereMedium(sampleRadius - ground, parameters);
                let scattering = medium.rayleighScattering + vec3f(medium.mieScattering);
                let stepTransmittance = exp(-medium.extinction * stepLength);
                let sampleLightCosine = dot(samplePoint, lightDirection) / sampleRadius;
                var lightTransmittance = transmittanceTowards(sampleRadius, sampleLightCosine, parameters);
                if (lightBelowHorizon(sampleRadius, sampleLightCosine, parameters)) {
                    lightTransmittance = vec3f(0.0);
                }
                let extinction = max(medium.extinction, vec3f(1e-9));
                let source = scattering * lightTransmittance / (4.0 * ATMOSPHERE_PI);
                radiance += transmittance * (source - source * stepTransmittance) / extinction;
                transfer += transmittance * (scattering - scattering * stepTransmittance) / extinction;
                transmittance *= stepTransmittance;
            }
            if (hitsGround) {
                let groundPoint = origin + direction * marchLength;
                let groundNormal = normalize(groundPoint);
                let groundLightCosine = dot(groundNormal, lightDirection);
                radiance += transmittance * transmittanceTowards(ground, groundLightCosine, parameters) * max(groundLightCosine, 0.0) * parameters.groundRadiusTopRadiusAlbedoMarineDensity.z / ATMOSPHERE_PI;
            }
            radianceSum += radiance;
            transferSum += transfer;
        }
    }
    let inverseCount = 1.0 / f32(directionsPerAxis * directionsPerAxis);
    let secondOrder = radianceSum * inverseCount;
    let transferFraction = transferSum * inverseCount;
    textureStore(multipleScatteringOutput, invocation.xy, vec4f(secondOrder / max(vec3f(1.0) - transferFraction, vec3f(1e-3)), 1.0));
}
