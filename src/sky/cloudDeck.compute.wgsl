/*
 * Derived from web-ocean by Maksymilian Dendura (Noniv): https://github.com/Noniv/web-ocean
 * Copyright (c) 2026 Maksymilian Dendura. MIT License; full text in LICENSE.
 */

#include<atmosphereCore>
#include<proceduralNoise>
#include<cloudDeckLayout>
#include<cloudDeckLighting>

struct CloudDeckParameters {
    shapeScaleDriftSoftnessDetail: vec4f,
    lightingForwardRimAmbientMasses: vec4f,
    texelRadiansBlobContrastBlobScale: vec4f,
};

@group(0) @binding(0) var<uniform> atmosphere: AtmosphereParameters;
@group(0) @binding(1) var transmittanceLutSampler: sampler;
@group(0) @binding(2) var transmittanceLut: texture_2d<f32>;
@group(0) @binding(3) var skyViewLut: texture_2d<f32>;
@group(0) @binding(4) var cloudDeckOutput: texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var<uniform> cloudDeck: CloudDeckParameters;
@group(0) @binding(6) var multipleScatteringLut: texture_2d<f32>;

const CLOUD_PATH_STEPS: u32 = 12u;

fn transmittanceTowards(radius: f32, cosine: f32, parameters: AtmosphereParameters) -> vec3f {
    return textureSampleLevel(transmittanceLut, transmittanceLutSampler, transmittanceRadiusCosineToUv(radius, cosine, parameters), 0.0).rgb;
}

fn clearSkyRadiance(direction: vec3f, cameraRadius: f32, parameters: AtmosphereParameters) -> vec3f {
    let uv = skyViewUvFromDirection(direction, parameters.lightDirectionAndCameraAltitude.xyz, cameraRadius, parameters);
    return textureSampleLevel(skyViewLut, transmittanceLutSampler, uv, 0.0).rgb * parameters.lightIlluminanceAndMarineScaleHeight.xyz;
}

fn bandLimitedFractalNoise(position: vec2f, footprintCells: f32) -> f32 {
    var sum = 0.0;
    var amplitude = 0.5;
    var point = position;
    var wavelengthCells = 1.0;
    let rotation = mat2x2f(0.8, 0.6, -0.6, 0.8);
    for (var octave = 0; octave < 6; octave++) {
        let resolved = smoothstep(1.5, 4.0, wavelengthCells / max(footprintCells, 1e-5));
        var value = gradientNoiseTwo(point);
        if (octave >= 2) {
            value = mix(value, abs(value) * 2.0 - 0.38, 0.3);
        }
        sum += amplitude * value * resolved;
        point = rotation * point * 2.03 + vec2f(13.1, 7.7);
        amplitude *= 0.5;
        wavelengthCells *= 0.4926;
    }
    return sum;
}

fn cloudThickness(position: vec2f, coverage: f32, footprintKilometres: f32) -> f32 {
    let shape = cloudDeck.shapeScaleDriftSoftnessDetail;
    let blobSettings = cloudDeck.texelRadiansBlobContrastBlobScale;
    let scale = shape.x;
    var point = (position + vec2f(shape.y, 0.0)) * scale;
    let warp = vec2f(gradientNoiseTwo(point * 0.3 + vec2f(1.7, 9.2)), gradientNoiseTwo(point * 0.3 + vec2f(8.3, 2.8)));
    point += warp * 1.2;
    let footprintCells = footprintKilometres * scale;
    let detail = bandLimitedFractalNoise(point * vec2f(1.0, 1.4), footprintCells);
    let masses = gradientNoiseTwo(position * scale * 0.08 + vec2f(3.1, 1.3)) * cloudDeck.lightingForwardRimAmbientMasses.w;
    let field = detail * shape.w + 0.5 + masses;
    let threshold = 1.0 - coverage;
    let presence = smoothstep(threshold - shape.z, threshold + shape.z, field) * saturate(coverage * 8.0);
    let blobResolved = smoothstep(1.5, 4.0, 1.0 / max(footprintCells * blobSettings.z, 1e-5));
    let blobs = mix(0.45, smoothstep(0.85, 0.15, cellularNearestDistance(point * blobSettings.z + vec2f(5.3, 2.1))), blobResolved);
    let lumpiness = 1.0 - blobSettings.y + 2.0 * blobSettings.y * blobs;
    return presence * presence * (0.35 + 0.8 * clamp(field - threshold, 0.0, 1.2)) * lumpiness;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) invocation: vec3u) {
    let size = textureDimensions(cloudDeckOutput);
    if (invocation.x >= size.x || invocation.y >= size.y) {
        return;
    }
    let parameters = atmosphere;
    let deck = parameters.deckAltitudeOpticalDepthBrightnessDirectPower;
    let uv = (vec2f(invocation.xy) + 0.5) / vec2f(size);
    let direction = cloudDeckDirectionFromUv(uv);
    let ground = groundRadius(parameters);
    let cameraRadius = ground + max(parameters.lightDirectionAndCameraAltitude.w, 0.001);
    let origin = vec3f(0.0, cameraRadius, 0.0);
    let layerRadius = ground + deck.x;
    let hitDistance = raySphereIntersection(origin, direction, layerRadius).y;
    let hitPoint = origin + direction * hitDistance;
    let up = normalize(hitPoint);
    let viewCosine = max(dot(up, direction), 0.03);
    let lightDirection = parameters.lightDirectionAndCameraAltitude.xyz;
    let illuminance = parameters.lightIlluminanceAndMarineScaleHeight.xyz;
    let coverage = deckCoverageTowards(direction, lightDirection, parameters);
    let elevationTexelRadians = 3.14159265 * max(uv.y, 0.5 / f32(size.y)) / f32(size.y);
    let texelRadians = max(cloudDeck.texelRadiansBlobContrastBlobScale.x, elevationTexelRadians);
    let footprintKilometres = hitDistance * texelRadians / viewCosine;
    let horizontalPosition = hitPoint.xz;
    let thickness = cloudThickness(horizontalPosition, coverage, footprintKilometres);
    var towardLight = lightDirection.xz;
    let towardLightLength = length(towardLight);
    towardLight = select(vec2f(0.0, 1.0), towardLight / max(towardLightLength, 1e-4), towardLightLength > 1e-4);
    let thicknessTowardLight = cloudThickness(horizontalPosition + towardLight * 0.35, coverage, footprintKilometres);
    let opticalDepth = thickness * deck.y;
    let viewOpticalDepth = opticalDepth / viewCosine;
    let opacity = 1.0 - exp(-viewOpticalDepth);
    let lightCosine = dot(up, lightDirection);
    let lightCosineClamped = max(lightCosine, 0.05);
    let lightAtDeck = transmittanceTowards(layerRadius, lightCosine, parameters) * illuminance;
    let diffuseTransmission = 1.0 / (1.0 + 0.75 * opticalDepth * (1.0 - CLOUD_DECK_ASYMMETRY));
    let directTransmission = exp(-opticalDepth / lightCosineClamped);
    let randomisedFraction = 1.0 - exp(-0.5 * opticalDepth);
    let diffuse = lightAtDeck * (lightCosineClamped * max(diffuseTransmission - directTransmission, 0.0) * randomisedFraction / ATMOSPHERE_PI);
    let gains = cloudDeck.lightingForwardRimAmbientMasses;
    let scatteringCosine = dot(direction, lightDirection);
    let phase = henyeyGreensteinPhase(scatteringCosine, 0.8);
    let rim = clamp((thickness - thicknessTowardLight) * 2.0, 0.0, 1.0);
    let forward = lightAtDeck * (phase * viewOpticalDepth * exp(-0.5 * opticalDepth * (1.0 / viewCosine + 1.0 / lightCosineClamped)) * gains.x * (1.0 + gains.y * rim));
    let skyAbove = clearSkyRadiance(vec3f(0.0, 1.0, 0.0), cameraRadius, parameters);
    let ambient = skyAbove * (diffuseTransmission * opacity * gains.z);
    let cloudRadiance = (diffuse + forward + ambient) * deck.z;
    let overcastBaseRadiance = overcastBaseRadiancePerIlluminance(lightDirection, parameters);
    let rayleighWeight = rayleighPhase(scatteringCosine);
    let mieWeight = miePhaseCornetteShanks(scatteringCosine, parameters.mieScatteringExtinctionScaleHeightAsymmetry.w);
    let top = topRadius(parameters);
    var inscatter = vec3f(0.0);
    var pathTransmittance = vec3f(1.0);
    var previousDistance = 0.0;
    for (var stepIndex = 0u; stepIndex < CLOUD_PATH_STEPS; stepIndex++) {
        let fraction = (f32(stepIndex) + 1.0) / f32(CLOUD_PATH_STEPS);
        let nextDistance = hitDistance * fraction * fraction;
        let stepLength = nextDistance - previousDistance;
        let samplePoint = origin + direction * (previousDistance + stepLength * 0.5);
        previousDistance = nextDistance;
        let sampleRadius = length(samplePoint);
        let height = sampleRadius - ground;
        let medium = atmosphereMedium(height, parameters);
        let sampleLightCosine = dot(samplePoint, lightDirection) / sampleRadius;
        let lightTransmittance = transmittanceTowards(sampleRadius, sampleLightCosine, parameters);
        let multipleScatteringUv = vec2f(unitToSubUv(sampleLightCosine * 0.5 + 0.5, MULTIPLE_SCATTERING_LUT_SIZE), unitToSubUv(clamp(height / (top - ground), 0.0, 1.0), MULTIPLE_SCATTERING_LUT_SIZE));
        let multipleScattering = textureSampleLevel(multipleScatteringLut, transmittanceLutSampler, multipleScatteringUv, 0.0).rgb;
        let directFraction = deckDirectLightFraction(samplePoint, origin, lightDirection, parameters);
        let source = (lightTransmittance * (medium.rayleighScattering * rayleighWeight + vec3f(medium.mieScattering * mieWeight))
            + multipleScattering * (medium.rayleighScattering + vec3f(medium.mieScattering))) * directFraction
            + underDeckAmbientSource(height, medium, overcastBaseRadiance, parameters);
        let stepTransmittance = exp(-medium.extinction * stepLength);
        let extinction = max(medium.extinction, vec3f(1e-9));
        inscatter += pathTransmittance * (source - source * stepTransmittance) / extinction;
        pathTransmittance *= stepTransmittance;
    }
    let inscatterInFront = inscatter * illuminance;
    textureStore(cloudDeckOutput, invocation.xy, vec4f(cloudRadiance * pathTransmittance + inscatterInFront * opacity, opacity));
}
