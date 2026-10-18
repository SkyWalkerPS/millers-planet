#include<frameUniforms>
#include<beautyOutputs>
#include<atmosphereCore>
#include<cloudDeckLayout>
#include<aerialPerspectiveLayout>
#include<suitMaterialParameters>
#include<sceneProxyParameters>
#include<proceduralNoise>
#include<waveShape>

var<uniform> frame: FrameUniforms;
var<uniform> atmosphere: AtmosphereParameters;
var<uniform> suitMaterial: SuitMaterialParameters;
var<uniform> sceneProxies: SceneProxyParameters;
var<uniform> waveParameters: WaveParameters;
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
varying vWorldPosition: vec3f;
varying vWorldNormal: vec3f;
varying vSurfaceUv: vec2f;
varying vAux: vec2f;
varying vBindPosition: vec3f;
varying vCurrentClip: vec4f;
varying vPreviousClip: vec4f;

#include<gargantuaSampling>
#include<skyComposite>
#include<aerialPerspectiveApply>
#include<waveReflection>
#include<cloudDeckLighting>
#include<suitLighting>
#include<sceneProxyQueries>

const SLOT_SUIT_FABRIC: u32 = 0u;
const SLOT_ACCENT_FABRIC: u32 = 1u;
const SLOT_BELLOWS: u32 = 5u;
const SLOT_PATCH: u32 = 6u;

fn ripstopPattern(surfaceUv: vec2f) -> f32 {
    let cellsPerMetre = 140.0;
    let scaled = surfaceUv * cellsPerMetre;
    let footprint = max(length(fwidth(scaled)), 1e-4);
    let fade = 1.0 - smoothstep(0.25, 0.6, footprint);
    let distanceToLine = abs(fract(scaled) - 0.5);
    let line = 1.0 - smoothstep(0.38, 0.47, max(distanceToLine.x, distanceToLine.y));
    return 1.0 - 0.12 * (1.0 - line) * fade;
}

fn patchColour(bindPosition: vec3f) -> vec3f {
    let local = vec2f((bindPosition.x - 0.11) / 0.04, (bindPosition.y - 1.365) / 0.04);
    let ringDistance = abs(length(local * vec2f(1.0, 1.6)) - 0.55);
    let ringMark = 1.0 - smoothstep(0.08, 0.14, ringDistance);
    let barMark = (1.0 - smoothstep(0.06, 0.1, abs(local.y + 0.05))) * (1.0 - smoothstep(0.7, 0.8, abs(local.x)));
    let mark = max(ringMark, barMark);
    return mix(vec3f(0.42, 0.12, 0.07), vec3f(0.78, 0.76, 0.7), mark);
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let slot = u32(clamp(input.vAux.x + 0.5, 0.0, 7.0));
    let occlusion = input.vAux.y;
    let slotSurface = suitMaterial.slotAlbedoAndRoughness[slot];
    let slotProperties = suitMaterial.slotMetalSheenWeaveWet[slot];
    var albedo = slotSurface.rgb;
    var roughness = slotSurface.a;
    let metallic = slotProperties.x;
    let ripstop = ripstopPattern(input.vSurfaceUv);
    let slub = gradientNoiseTwo(input.vSurfaceUv * vec2f(9.0, 26.0)) * 0.5 + 0.5;
    let fabricMask = select(0.0, 1.0, slot == SLOT_SUIT_FABRIC || slot == SLOT_ACCENT_FABRIC || slot == SLOT_BELLOWS);
    albedo *= mix(1.0, ripstop * (0.94 + 0.12 * slub), fabricMask);
    if (slot == SLOT_PATCH) {
        albedo = patchColour(input.vBindPosition);
    }
    let water = suitMaterial.waterLevelWetAllWetBandSeaBounce;
    let world = input.vWorldPosition;
    let wetness = max(water.y, 1.0 - smoothstep(water.x, water.x + water.z, world.y)) * slotProperties.w;
    albedo *= mix(1.0, 0.6, wetness);
    roughness = mix(roughness, 0.15, wetness);
    let toCamera = frame.cameraPositionAndTime.xyz - world;
    let viewDistance = length(toCamera);
    let view = toCamera / max(viewDistance, 1e-4);
    var normal = normalize(input.vWorldNormal);
    if (dot(normal, view) < 0.0) {
        normal = -normal;
    }
    var environment = suitLightEnvironment(world);
    environment.directIrradiance *= shipShadowVisibility(world, environment.lightDirection, tan(frame.keyLightDirectionAndAngularRadius.w));
    let lightDirection = environment.lightDirection;
    let normalDotLight = max(dot(normal, lightDirection), 0.0);
    let normalDotView = max(dot(normal, view), 1e-3);
    let alpha = max(roughness * roughness, 0.02);
    let halfVector = normalize(lightDirection + view);
    let baseReflectance = mix(vec3f(0.04), albedo, metallic);
    let fresnel = schlickFresnel(baseReflectance, max(dot(halfVector, view), 0.0));
    let specularDirect = ggxDistribution(max(dot(normal, halfVector), 0.0), alpha) * smithCorrelatedVisibility(normalDotView, normalDotLight, alpha) * fresnel;
    let diffuseColour = albedo * (1.0 - metallic);
    let skyFacing = 0.5 + 0.5 * normal.y;
    let ambientIrradiance = environment.skyIrradiance * (skyFacing + water.w * (1.0 - skyFacing)) * occlusion;
    let sheen = slotProperties.y * pow(1.0 - normalDotView, 4.0) * 0.5;
    var radiance = diffuseColour / ATMOSPHERE_PI * (environment.directIrradiance * normalDotLight + ambientIrradiance);
    radiance += specularDirect * environment.directIrradiance * normalDotLight;
    let reflected = reflect(-view, normal);
    let levels = reflectionMipLevels(roughness);
    let environmentSample = environmentRadiance(reflected, environment, levels.x, levels.y, 0.045);
    radiance += environmentSample * environmentBrdfApproximation(baseReflectance, roughness, normalDotView) * mix(occlusion, 1.0, 0.4);
    radiance += environment.skyIrradiance / ATMOSPHERE_PI * albedo * sheen;
    let currentClip = input.vCurrentClip;
    radiance = applyAerialPerspective(radiance, currentClip, viewDistance);
    fragmentOutputs.fragData0 = vec4f(radiance, 1.0);
    fragmentOutputs.fragData1 = packMotionDepthAndSurface(currentClip, input.vPreviousClip, SURFACE_CODE_CHARACTER);
}
