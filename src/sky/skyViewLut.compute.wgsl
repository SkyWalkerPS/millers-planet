/*
 * Derived from web-ocean by Maksymilian Dendura (Noniv): https://github.com/Noniv/web-ocean
 * Copyright (c) 2026 Maksymilian Dendura. MIT License; full text in LICENSE.
 */

#include<atmosphereCore>
#include<cloudDeckLighting>

@group(0) @binding(0) var<uniform> atmosphere: AtmosphereParameters;
@group(0) @binding(1) var transmittanceLutSampler: sampler;
@group(0) @binding(2) var transmittanceLut: texture_2d<f32>;
@group(0) @binding(3) var multipleScatteringLut: texture_2d<f32>;
@group(0) @binding(4) var skyViewOutput: texture_storage_2d<rgba16float, write>;

fn transmittanceTowards(radius: f32, cosine: f32, parameters: AtmosphereParameters) -> vec3f {
    return textureSampleLevel(transmittanceLut, transmittanceLutSampler, transmittanceRadiusCosineToUv(radius, cosine, parameters), 0.0).rgb;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) invocation: vec3u) {
    if (f32(invocation.x) >= SKY_VIEW_LUT_WIDTH || f32(invocation.y) >= SKY_VIEW_LUT_HEIGHT) {
        return;
    }
    let parameters = atmosphere;
    let ground = groundRadius(parameters);
    let top = topRadius(parameters);
    var uv = (vec2f(invocation.xy) + 0.5) / vec2f(SKY_VIEW_LUT_WIDTH, SKY_VIEW_LUT_HEIGHT);
    uv = vec2f(subUvToUnit(uv.x, SKY_VIEW_LUT_WIDTH), subUvToUnit(uv.y, SKY_VIEW_LUT_HEIGHT));
    let radius = ground + max(parameters.lightDirectionAndCameraAltitude.w, 0.001);
    let horizonCosine = distanceToHorizon(radius, parameters) / radius;
    let beta = acos(clamp(horizonCosine, -1.0, 1.0));
    let zenithAngleOfHorizon = ATMOSPHERE_PI - beta;
    var viewZenithAngle: f32;
    if (uv.y < 0.5) {
        var coordinate = 2.0 * uv.y;
        coordinate = 1.0 - coordinate;
        coordinate *= coordinate;
        coordinate = 1.0 - coordinate;
        viewZenithAngle = zenithAngleOfHorizon * coordinate;
    } else {
        var coordinate = uv.y * 2.0 - 1.0;
        coordinate *= coordinate;
        viewZenithAngle = zenithAngleOfHorizon + beta * coordinate;
    }
    let azimuthCosine = -(uv.x * uv.x * 2.0 - 1.0);
    let azimuthSine = sqrt(max(0.0, 1.0 - azimuthCosine * azimuthCosine));
    let direction = vec3f(sin(viewZenithAngle) * azimuthCosine, cos(viewZenithAngle), sin(viewZenithAngle) * azimuthSine);
    let lightElevationSine = parameters.lightDirectionAndCameraAltitude.y;
    let lightDirection = vec3f(sqrt(max(0.0, 1.0 - lightElevationSine * lightElevationSine)), lightElevationSine, 0.0);
    let origin = vec3f(0.0, radius, 0.0);
    let topHit = raySphereIntersection(origin, direction, top);
    let groundHit = raySphereIntersection(origin, direction, ground);
    var marchLength = topHit.y;
    if (groundHit.x > 0.0) {
        marchLength = groundHit.x;
    }
    let scatteringCosine = dot(direction, lightDirection);
    let rayleighWeight = rayleighPhase(scatteringCosine);
    let mieWeight = miePhaseCornetteShanks(scatteringCosine, parameters.mieScatteringExtinctionScaleHeightAsymmetry.w);
    let overcastBaseRadiance = overcastBaseRadiancePerIlluminance(lightDirection, parameters);
    var radiance = vec3f(0.0);
    var transmittance = vec3f(1.0);
    let stepCount = 48u;
    var previousDistance = 0.0;
    for (var stepIndex = 0u; stepIndex < stepCount; stepIndex++) {
        let fraction = (f32(stepIndex) + 1.0) / f32(stepCount);
        let nextDistance = marchLength * fraction * fraction;
        let stepLength = nextDistance - previousDistance;
        let sampleDistance = previousDistance + stepLength * 0.3;
        previousDistance = nextDistance;
        let samplePoint = origin + direction * sampleDistance;
        let sampleRadius = length(samplePoint);
        let height = sampleRadius - ground;
        let medium = atmosphereMedium(height, parameters);
        let sampleLightCosine = dot(samplePoint, lightDirection) / sampleRadius;
        var lightTransmittance = transmittanceTowards(sampleRadius, sampleLightCosine, parameters);
        if (lightBelowHorizon(sampleRadius, sampleLightCosine, parameters)) {
            lightTransmittance = vec3f(0.0);
        }
        let multipleScatteringUv = vec2f(unitToSubUv(sampleLightCosine * 0.5 + 0.5, MULTIPLE_SCATTERING_LUT_SIZE), unitToSubUv(clamp(height / (top - ground), 0.0, 1.0), MULTIPLE_SCATTERING_LUT_SIZE));
        let multipleScattering = textureSampleLevel(multipleScatteringLut, transmittanceLutSampler, multipleScatteringUv, 0.0).rgb;
        let directFraction = deckDirectLightFraction(samplePoint, origin, lightDirection, parameters);
        let source = (lightTransmittance * (medium.rayleighScattering * rayleighWeight + vec3f(medium.mieScattering * mieWeight))
            + multipleScattering * (medium.rayleighScattering + vec3f(medium.mieScattering))) * directFraction
            + underDeckAmbientSource(height, medium, overcastBaseRadiance, parameters);
        let stepTransmittance = exp(-medium.extinction * stepLength);
        let extinction = max(medium.extinction, vec3f(1e-9));
        radiance += transmittance * (source - source * stepTransmittance) / extinction;
        transmittance *= stepTransmittance;
    }
    textureStore(skyViewOutput, invocation.xy, vec4f(radiance, 1.0));
}
