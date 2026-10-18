/*
 * Derived from web-ocean by Maksymilian Dendura (Noniv): https://github.com/Noniv/web-ocean
 * Copyright (c) 2026 Maksymilian Dendura. MIT License; full text in LICENSE.
 */

#include<frameUniforms>
#include<beautyOutputs>
#include<atmosphereCore>
#include<cloudDeckLayout>
#include<aerialPerspectiveLayout>
#include<seaSurfaceParameters>
#include<proceduralNoise>

var<uniform> frame: FrameUniforms;
var<uniform> atmosphere: AtmosphereParameters;
var<uniform> seaSurface: SeaSurfaceParameters;
var gargantuaCurrentPatch: texture_2d<f32>;
var gargantuaCurrentPatchSampler: sampler;
var gargantuaPreviousPatch: texture_2d<f32>;
var gargantuaPreviousPatchSampler: sampler;
var transmittanceLut: texture_2d<f32>;
var transmittanceLutSampler: sampler;
var skyViewLut: texture_2d<f32>;
var skyViewLutSampler: sampler;
var cloudDeckTexture: texture_2d<f32>;
var cloudDeckTextureSampler: sampler;
var aerialPerspectiveVolume: texture_3d<f32>;
var aerialPerspectiveVolumeSampler: sampler;
var displacementTexture: texture_2d_array<f32>;
var displacementTextureSampler: sampler;
var derivativeTexture: texture_2d_array<f32>;
var derivativeTextureSampler: sampler;
var momentTexture: texture_2d_array<f32>;
var momentTextureSampler: sampler;
var rippleTexture: texture_2d<f32>;
var rippleTextureSampler: sampler;
varying vWorldPosition: vec3f;
varying vLagrangian: vec2f;

#include<gargantuaSampling>
#include<skyComposite>
#include<aerialPerspectiveApply>
#include<cloudDeckLighting>
#include<seabed>

const GARGANTUA_PATCH_TEXEL_RADIANS: f32 = 0.00075;
const CLOUD_DECK_TEXEL_RADIANS: f32 = 0.00153;

fn rippleSlopeAndFoam(world: vec2f, footprint: f32) -> vec3f {
    let fade = rippleWindowFade(world);
    let period = 2.0 * seaSurface.rippleWindowCentreHalfTexel.z;
    let baseline = max(2.0 * seaSurface.rippleWindowCentreHalfTexel.w, footprint * 1.4);
    let uv = world / period;
    let sampleOffset = baseline / period;
    let right = textureSampleLevel(rippleTexture, rippleTextureSampler, uv + vec2f(sampleOffset, 0.0), 0.0).x;
    let left = textureSampleLevel(rippleTexture, rippleTextureSampler, uv - vec2f(sampleOffset, 0.0), 0.0).x;
    let ahead = textureSampleLevel(rippleTexture, rippleTextureSampler, uv + vec2f(0.0, sampleOffset), 0.0).x;
    let behind = textureSampleLevel(rippleTexture, rippleTextureSampler, uv - vec2f(0.0, sampleOffset), 0.0).x;
    let foam = textureSampleLevel(rippleTexture, rippleTextureSampler, uv, 0.0).z;
    return vec3f(vec2f(right - left, ahead - behind) / (2.0 * baseline), foam) * fade;
}

fn fresnelWater(cosine: f32) -> f32 {
    let complement = 1.0 - clamp(cosine, 0.0, 1.0);
    let squared = complement * complement;
    return 0.02 + 0.98 * squared * squared * complement;
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let lagrangian = input.vLagrangian;
    var slope = vec2f(0.0);
    var jacobianXX = 0.0;
    var jacobianZZ = 0.0;
    var covariance = vec3f(0.0);
    var surfaceHeight = 0.0;
    for (var cascade = 0u; cascade < 3u; cascade++) {
        let uv = lagrangian * seaSurface.cascadeInverseSizes[cascade];
        let derivatives = textureSample(derivativeTexture, derivativeTextureSampler, uv, cascade);
        let moments = textureSample(momentTexture, momentTextureSampler, uv, cascade);
        let displacement = textureSample(displacementTexture, displacementTextureSampler, uv, cascade);
        slope += derivatives.xy;
        jacobianXX += derivatives.z;
        jacobianZZ += derivatives.w;
        surfaceHeight += displacement.y;
        covariance += vec3f(max(moments.x - derivatives.x * derivatives.x, 0.0), max(moments.y - derivatives.y * derivatives.y, 0.0), moments.z - derivatives.x * derivatives.y);
    }
    let world = input.vWorldPosition;
    let surfaceFootprint = max(length(dpdx(world.xz)), length(dpdy(world.xz)));
    let ripple = rippleSlopeAndFoam(lagrangian, surfaceFootprint);
    slope += ripple.xy;
    let toCamera = frame.cameraPositionAndTime.xyz - world;
    let viewDistance = length(toCamera);
    let view = toCamera / max(viewDistance, 1e-4);
    let optics = seaSurface.slopeOptics;
    covariance.x += optics.x;
    covariance.y += optics.x;
    let stretchX = max(1.0 + jacobianXX, 0.15);
    let stretchZ = max(1.0 + jacobianZZ, 0.15);
    let surfaceSlope = vec2f(slope.x / stretchX, slope.y / stretchZ);
    let normal = normalize(vec3f(-surfaceSlope.x, 1.0, -surfaceSlope.y));
    let slopeDerivativeX = dpdx(surfaceSlope);
    let slopeDerivativeY = dpdy(surfaceSlope);
    let antiAliasing = vec3f(
        slopeDerivativeX.x * slopeDerivativeX.x + slopeDerivativeY.x * slopeDerivativeY.x,
        slopeDerivativeX.y * slopeDerivativeX.y + slopeDerivativeY.y * slopeDerivativeY.y,
        slopeDerivativeX.x * slopeDerivativeX.y + slopeDerivativeY.x * slopeDerivativeY.y) * 0.5;
    covariance += antiAliasing * min(1.0, 0.03 / max(max(antiAliasing.x, antiAliasing.y), 1e-8));

    let slopeDeviation = sqrt(max(covariance.x + covariance.y, 1e-6) * 0.5);
    let horizontalView = normalize(vec3f(view.x, 0.0, view.z) + vec3f(1e-5, 0.0, 0.0));
    let viewSlopeDeviation = sqrt(max(horizontalView.x * horizontalView.x * covariance.x + horizontalView.z * horizontalView.z * covariance.y + 2.0 * horizontalView.x * horizontalView.z * covariance.z, 1e-6));
    let grazing = max(view.y, 1e-3) / max(sqrt(1.0 - view.y * view.y), 1e-3) / (1.4142 * viewSlopeDeviation);
    let tilt = 0.32 * viewSlopeDeviation * (1.0 - smoothstep(0.0, 2.5, grazing));
    let reflectingNormal = normalize(normal + horizontalView * tilt);
    var reflected = reflect(-view, reflectingNormal);
    reflected.y = abs(reflected.y) * 0.4 + max(reflected.y, 0.0) * 0.6;
    reflected = normalize(reflected);
    let spreadRadians = 2.0 * slopeDeviation + optics.y;
    let gargantuaLevel = log2(max(spreadRadians / GARGANTUA_PATCH_TEXEL_RADIANS, 1.0));
    let cloudLevel = log2(max(spreadRadians / CLOUD_DECK_TEXEL_RADIANS, 1.0));
    let reflection = skyRadianceBlurred(reflected, gargantuaLevel, cloudLevel);
    let fresnelNormal = normalize(mix(normal, vec3f(0.0, 1.0, 0.0), optics.w));
    let fresnel = fresnelWater(max(dot(fresnelNormal, view), 0.0));

    let lightDirection = atmosphere.lightDirectionAndCameraAltitude.xyz;
    let illuminance = atmosphere.lightIlluminanceAndMarineScaleHeight.xyz;
    let planetRadius = groundRadius(atmosphere);
    let surfacePoint = vec3f(0.0, planetRadius + 0.0005, 0.0);
    let directFraction = deckDirectLightFraction(surfacePoint + vec3f(world.x - frame.cameraPositionAndTime.x, 0.0, world.z - frame.cameraPositionAndTime.z) * 0.001, vec3f(0.0, planetRadius + atmosphere.lightDirectionAndCameraAltitude.w, 0.0), lightDirection, atmosphere);
    let directIrradiance = illuminance * transmittanceToSpace(lightDirection) * (max(lightDirection.y, 0.0) * directFraction);
    let skyIrradiance = overcastBaseRadiancePerIlluminance(lightDirection, atmosphere) * illuminance * (ATMOSPHERE_PI * atmosphere.deckClearingCoverageInnerOuterOvercast.w * atmosphere.deckAmbientGainAndBakeOriginKilometres.x);

    let refractionIndexInverse = 1.0 / optics.z;
    let bodyNormal = normalize(mix(normal, vec3f(0.0, 1.0, 0.0), 0.5));
    let refracted = refract(-view, bodyNormal, refractionIndexInverse);
    let waterDepth = max(seabedDepthAt(world.xz) + surfaceHeight, 0.02);
    let pathDown = waterDepth / max(-refracted.y, 0.2);
    let bedPosition = world.xz + refracted.xz * pathDown;
    let relief = seabedRippleMarkRelief(bedPosition, surfaceFootprint);
    let bedNormal = normalize(vec3f(-relief.gradient.x, 1.0, -relief.gradient.y));
    let albedo = seabedAlbedoAt(bedPosition, surfaceFootprint) * mix(0.74, 1.08, relief.crestFraction);
    let absorption = seaSurface.waterAbsorptionAndScattering.xyz;
    let scattering = seaSurface.waterAbsorptionAndScattering.w;
    let extinction = absorption + vec3f(scattering);
    let lightCosineInWater = max(sqrt(1.0 - (1.0 - lightDirection.y * lightDirection.y) * refractionIndexInverse * refractionIndexInverse), 0.3);
    let towardLightInWater = normalize(vec3f(lightDirection.x * refractionIndexInverse, lightCosineInWater, lightDirection.z * refractionIndexInverse));
    let reliefLighting = max(dot(bedNormal, towardLightInWater), 0.0) / towardLightInWater.y;
    let lightPath = waterDepth / lightCosineInWater;
    let bedIrradiance = directIrradiance * (1.0 - fresnelWater(max(lightDirection.y, 0.0))) * exp(-extinction * lightPath) * reliefLighting + skyIrradiance * 0.94 * exp(-extinction * waterDepth * 1.6) * bedNormal.y;
    let bedRadiance = albedo / ATMOSPHERE_PI * bedIrradiance;
    let viewTransmittance = exp(-extinction * pathDown);
    let inWaterLight = (skyIrradiance + directIrradiance * 0.6) / ATMOSPHERE_PI;
    let scatteredInWater = seaSurface.waterScatteringColourAndDepth.xyz * inWaterLight * (vec3f(1.0) - viewTransmittance) * (scattering / max(extinction, vec3f(1e-4)));
    let body = (bedRadiance * viewTransmittance + scatteredInWater) * 0.563;
    var radiance = body * (1.0 - fresnel) + reflection * fresnel;
    let foamRadiance = (skyIrradiance + directIrradiance) * (0.75 / ATMOSPHERE_PI);
    radiance = mix(radiance, foamRadiance, clamp(ripple.z, 0.0, 1.0) * 0.7);

    let currentClip = frame.viewProjection * vec4f(world, 1.0);
    let previousClip = frame.previousViewProjection * vec4f(world, 1.0);
    radiance = applyAerialPerspective(radiance, currentClip, viewDistance);
    fragmentOutputs.fragData0 = vec4f(radiance, 1.0);
    fragmentOutputs.fragData1 = packMotionDepthAndSurface(currentClip, previousClip, SURFACE_CODE_SEA);
}
