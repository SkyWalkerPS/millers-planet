/*
 * Derived from web-ocean by Maksymilian Dendura (Noniv): https://github.com/Noniv/web-ocean
 * Copyright (c) 2026 Maksymilian Dendura. MIT License; full text in LICENSE.
 */

#include<atmosphereCore>
#include<cloudDeckLighting>
#include<frameUniforms>
#include<aerialPerspectiveLayout>

@group(0) @binding(0) var<uniform> atmosphere: AtmosphereParameters;
@group(0) @binding(1) var transmittanceLutSampler: sampler;
@group(0) @binding(2) var transmittanceLut: texture_2d<f32>;
@group(0) @binding(3) var multipleScatteringLut: texture_2d<f32>;
@group(0) @binding(4) var aerialPerspectiveOutput: texture_storage_3d<rgba16float, write>;
@group(0) @binding(5) var<uniform> frame: FrameUniforms;

fn transmittanceTowards(radius: f32, cosine: f32, parameters: AtmosphereParameters) -> vec3f {
    return textureSampleLevel(transmittanceLut, transmittanceLutSampler, transmittanceRadiusCosineToUv(radius, cosine, parameters), 0.0).rgb;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) invocation: vec3u) {
    if (invocation.x >= AERIAL_PERSPECTIVE_SIZE || invocation.y >= AERIAL_PERSPECTIVE_SIZE) {
        return;
    }
    let parameters = atmosphere;
    let ground = groundRadius(parameters);
    let top = topRadius(parameters);
    let ndc = (vec2f(invocation.xy) + 0.5) / f32(AERIAL_PERSPECTIVE_SIZE) * 2.0 - 1.0;
    let nearPoint = frame.inverseViewProjection * vec4f(ndc, 1.0, 1.0);
    let direction = normalize(nearPoint.xyz / nearPoint.w - frame.cameraPositionAndTime.xyz);
    let origin = vec3f(0.0, ground + max(parameters.lightDirectionAndCameraAltitude.w, 0.001), 0.0);
    let lightDirection = parameters.lightDirectionAndCameraAltitude.xyz;
    let scatteringCosine = dot(direction, lightDirection);
    let rayleighWeight = rayleighPhase(scatteringCosine);
    let mieWeight = miePhaseCornetteShanks(scatteringCosine, parameters.mieScatteringExtinctionScaleHeightAsymmetry.w);
    let illuminance = parameters.lightIlluminanceAndMarineScaleHeight.xyz;
    let overcastBaseRadiance = overcastBaseRadiancePerIlluminance(lightDirection, parameters);
    var radiance = vec3f(0.0);
    var transmittance = vec3f(1.0);
    var previousDistance = 0.0;
    for (var slice = 0u; slice < AERIAL_PERSPECTIVE_SIZE; slice++) {
        let fraction = (f32(slice) + 1.0) / f32(AERIAL_PERSPECTIVE_SIZE);
        let nextDistance = AERIAL_PERSPECTIVE_FAR_KILOMETRES * fraction * fraction;
        let stepLength = nextDistance - previousDistance;
        let sampleDistance = previousDistance + stepLength * 0.5;
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
        textureStore(aerialPerspectiveOutput, vec3u(invocation.xy, slice), vec4f(radiance * illuminance, dot(transmittance, vec3f(1.0 / 3.0))));
    }
}
