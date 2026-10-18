#include<frameUniforms>
#include<beautyOutputs>
#include<atmosphereCore>
#include<cloudDeckLayout>
#include<aerialPerspectiveLayout>

var<uniform> frame: FrameUniforms;
var<uniform> atmosphere: AtmosphereParameters;
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
varying vScreenNdc: vec2f;

#include<gargantuaSampling>
#include<skyComposite>
#include<aerialPerspectiveApply>

fn distantSeaPlaceholder(direction: vec3f, currentClip: vec4f) -> vec3f {
    let eyeHeight = max(frame.cameraPositionAndTime.y, 0.3);
    let downward = max(-direction.y, 1e-5);
    let distanceMetres = eyeHeight / downward;
    let reflected = vec3f(direction.x, downward, direction.z);
    let fresnel = 0.02 + 0.98 * pow(1.0 - downward, 5.0);
    let bodyColour = vec3f(0.010, 0.014, 0.013);
    let surface = mix(bodyColour, skyRadianceAboveHorizon(reflected), fresnel);
    return applyAerialPerspective(surface, currentClip, distanceMetres);
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let unjitteredNdc = input.vScreenNdc - frame.jitterNdcAndInternalSize.xy;
    let pointOnNearPlane = frame.inverseViewProjection * vec4f(unjitteredNdc, 1.0, 1.0);
    let direction = normalize(pointOnNearPlane.xyz / pointOnNearPlane.w - frame.cameraPositionAndTime.xyz);
    let previousClip = frame.previousViewProjection * vec4f(direction, 0.0);
    let currentClip = frame.viewProjection * vec4f(direction, 0.0);
    let motion = screenMotionFromClipPositions(currentClip, previousClip);
    var radiance: vec3f;
    var surfaceCode = SURFACE_CODE_SKY;
    if (direction.y >= 0.0) {
        radiance = skyRadianceAboveHorizon(direction);
    } else {
        radiance = distantSeaPlaceholder(direction, currentClip);
        surfaceCode = SURFACE_CODE_SEA;
    }
    fragmentOutputs.fragData0 = vec4f(radiance, 1.0);
    fragmentOutputs.fragData1 = vec4f(motion, SKY_VIEW_DEPTH_METRES, surfaceCode);
}
