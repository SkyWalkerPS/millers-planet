#include<frameUniforms>
#include<beautyOutputs>
#include<atmosphereCore>
#include<cloudDeckLayout>
#include<aerialPerspectiveLayout>
#include<sceneProxyParameters>
#include<proceduralNoise>
#include<waveShape>

uniform world: mat4x4f;
uniform previousWorld: mat4x4f;
uniform damageAndWaterLevel: vec4f;
var<uniform> frame: FrameUniforms;
var<uniform> atmosphere: AtmosphereParameters;
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
varying vCurrentClip: vec4f;
varying vPreviousClip: vec4f;

#include<gargantuaSampling>
#include<skyComposite>
#include<aerialPerspectiveApply>
#include<waveReflection>
#include<cloudDeckLighting>
#include<suitLighting>
#include<sceneProxyQueries>

const LANDER_SLOT_HULL: u32 = 0u;
const LANDER_SLOT_GLASS: u32 = 2u;
const LANDER_SLOT_METAL: u32 = 3u;

fn landerAlbedoAndRoughness(slot: u32) -> vec4f {
    switch slot {
        case 0u: { return vec4f(0.8, 0.79, 0.76, 0.4); }
        case 1u: { return vec4f(0.045, 0.047, 0.052, 0.55); }
        case 2u: { return vec4f(0.008, 0.013, 0.024, 0.05); }
        case 3u: { return vec4f(0.56, 0.62, 0.7, 0.3); }
        case 4u: { return vec4f(0.022, 0.022, 0.025, 0.7); }
        case 6u: { return vec4f(0.15, 0.16, 0.175, 0.5); }
        case 7u: { return vec4f(0.86, 0.3, 0.05, 0.5); }
        default: { return vec4f(0.22, 0.21, 0.2, 0.75); }
    }
}

fn panelLines(surfaceUv: vec2f) -> f32 {
    let scaled = surfaceUv / vec2f(1.6, 2.3);
    let footprint = max(length(fwidth(scaled)), 1e-4);
    let fade = 1.0 - smoothstep(0.04, 0.12, footprint);
    let distanceToLine = abs(fract(scaled) - 0.5);
    let line = smoothstep(0.485, 0.497, max(distanceToLine.x, distanceToLine.y));
    return 1.0 - 0.28 * line * fade;
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let slot = u32(clamp(input.vAux.x + 0.5, 0.0, 7.0));
    let surface = landerAlbedoAndRoughness(slot);
    var albedo = surface.rgb;
    var roughness = surface.a;
    let metallic = select(0.0, 1.0, slot == LANDER_SLOT_METAL);
    let world = input.vWorldPosition;
    let lines = panelLines(input.vSurfaceUv);
    let weathering = gradientNoiseTwo(input.vSurfaceUv * vec2f(0.7, 2.6)) * 0.5 + 0.5;
    let grime = gradientNoiseTwo(input.vSurfaceUv * 1.9 + vec2f(3.1, 7.7)) * 0.5 + 0.5;
    let damage = uniforms.damageAndWaterLevel.x;
    let hullMask = select(0.0, 1.0, slot == LANDER_SLOT_HULL);
    albedo *= mix(1.0, lines * (0.92 + 0.08 * weathering), hullMask);
    albedo *= 1.0 - damage * 0.45 * smoothstep(0.35, 0.85, grime);
    let waterLevel = uniforms.damageAndWaterLevel.y;
    let wetness = 1.0 - smoothstep(waterLevel, waterLevel + 0.18 + 0.25 * damage, world.y);
    albedo *= mix(1.0, 0.55, wetness);
    roughness = mix(roughness, 0.12, wetness);
    let toCamera = frame.cameraPositionAndTime.xyz - world;
    let viewDistance = length(toCamera);
    let view = toCamera / max(viewDistance, 1e-4);
    var normal = normalize(input.vWorldNormal);
    if (dot(normal, view) < 0.0) {
        normal = -normal;
    }
    var environment = suitLightEnvironment(world);
    let penumbraPerMetre = tan(frame.keyLightDirectionAndAngularRadius.w);
    environment.directIrradiance *= astronautShadowVisibility(world, environment.lightDirection, 0.0, environment.lightDirection, penumbraPerMetre);
    let lightDirection = environment.lightDirection;
    let normalDotLight = max(dot(normal, lightDirection), 0.0);
    let normalDotView = max(dot(normal, view), 1e-3);
    let alpha = max(roughness * roughness, 0.004);
    let halfVector = normalize(lightDirection + view);
    let baseReflectance = mix(vec3f(select(0.04, 0.05, slot == LANDER_SLOT_GLASS)), albedo, metallic);
    let fresnel = schlickFresnel(baseReflectance, max(dot(halfVector, view), 0.0));
    let specularDirect = ggxDistribution(max(dot(normal, halfVector), 0.0), alpha) * smithCorrelatedVisibility(normalDotView, normalDotLight, alpha) * fresnel;
    let diffuseColour = albedo * (1.0 - metallic);
    let skyFacing = 0.5 + 0.5 * normal.y;
    let ambientIrradiance = environment.skyIrradiance * (skyFacing + 0.06 * (1.0 - skyFacing));
    var radiance = diffuseColour / ATMOSPHERE_PI * (environment.directIrradiance * normalDotLight + ambientIrradiance);
    radiance += specularDirect * environment.directIrradiance * normalDotLight;
    let levels = reflectionMipLevels(roughness);
    let reflected = reflect(-view, normal);
    radiance += environmentRadiance(reflected, environment, levels.x, levels.y, 0.045) * environmentBrdfApproximation(baseReflectance, roughness, normalDotView);
    let currentClip = input.vCurrentClip;
    radiance = applyAerialPerspective(radiance, currentClip, viewDistance);
    fragmentOutputs.fragData0 = vec4f(radiance, 1.0);
    fragmentOutputs.fragData1 = packMotionDepthAndSurface(currentClip, input.vPreviousClip, SURFACE_CODE_SOLID);
}
