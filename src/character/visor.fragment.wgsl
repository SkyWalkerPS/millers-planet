#include<frameUniforms>
#include<beautyOutputs>
#include<atmosphereCore>
#include<cloudDeckLayout>
#include<aerialPerspectiveLayout>
#include<suitMaterialParameters>
#include<sceneProxyParameters>

var<uniform> frame: FrameUniforms;
var<uniform> atmosphere: AtmosphereParameters;
var<uniform> suitMaterial: SuitMaterialParameters;
var<uniform> sceneProxies: SceneProxyParameters;
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
#include<cloudDeckLighting>
#include<suitLighting>
#include<sceneProxyQueries>

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let world = input.vWorldPosition;
    let toCamera = frame.cameraPositionAndTime.xyz - world;
    let viewDistance = length(toCamera);
    let view = toCamera / max(viewDistance, 1e-4);
    var normal = normalize(input.vWorldNormal);
    if (dot(normal, view) < 0.0) {
        normal = -normal;
    }
    let environment = suitLightEnvironment(world);
    let roughness = suitMaterial.visorTintAndRoughness.w;
    let normalDotView = max(dot(normal, view), 1e-3);
    let reflected = reflect(-view, normal);
    let levels = reflectionMipLevels(roughness);
    let reflection = environmentRadiance(reflected, environment, levels.x, levels.y, 0.045);
    let reflectance = schlickFresnel(suitMaterial.visorBaseReflectance.rgb, normalDotView);
    let interior = suitMaterial.visorTintAndRoughness.rgb * environment.skyIrradiance / ATMOSPHERE_PI * 0.02;
    var radiance = reflection * reflectance + interior * (vec3f(1.0) - reflectance);
    let currentClip = input.vCurrentClip;
    radiance = applyAerialPerspective(radiance, currentClip, viewDistance);
    fragmentOutputs.fragData0 = vec4f(radiance, 1.0);
    fragmentOutputs.fragData1 = packMotionDepthAndSurface(currentClip, input.vPreviousClip, SURFACE_CODE_CHARACTER);
}
