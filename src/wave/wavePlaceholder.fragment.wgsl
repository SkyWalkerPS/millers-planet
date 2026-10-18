#include<frameUniforms>
#include<beautyOutputs>
#include<atmosphereCore>
#include<cloudDeckLayout>
#include<aerialPerspectiveLayout>
#include<waveReservationParameters>
#include<proceduralNoise>

var<uniform> frame: FrameUniforms;
var<uniform> atmosphere: AtmosphereParameters;
var<uniform> waveReservation: WaveReservationParameters;
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
var derivativeTexture: texture_2d_array<f32>;
var derivativeTextureSampler: sampler;
var momentTexture: texture_2d_array<f32>;
var momentTextureSampler: sampler;
varying vWorldPosition: vec3f;
varying vProfile: vec2f;

#include<gargantuaSampling>
#include<skyComposite>
#include<aerialPerspectiveApply>

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let world = input.vWorldPosition;
    let height = waveReservation.travelDirectionAndHeight.w;
    let widths = waveReservation.shapeWidths;
    let scaled = input.vProfile.x / widths.x;
    let profileSlope = -2.0 * height / widths.x * tanh(scaled) / (cosh(scaled) * cosh(scaled));
    let travel = normalize(waveReservation.travelDirectionAndHeight.xz);
    var slope = vec2f(-travel * profileSlope);
    var covariance = vec3f(0.0);
    for (var cascade = 0u; cascade < 3u; cascade++) {
        let uv = world.xz * (0.02 / (f32(cascade) * 2.0 + 1.0)) + vec2f(world.y * 0.01, 0.0);
        let derivatives = textureSample(derivativeTexture, derivativeTextureSampler, uv, cascade);
        let moments = textureSample(momentTexture, momentTextureSampler, uv, cascade);
        slope += derivatives.xy * 6.0;
        covariance += moments.xyz;
    }
    let normal = normalize(vec3f(-slope.x, 1.0, -slope.y));
    let toCamera = frame.cameraPositionAndTime.xyz - world;
    let viewDistance = length(toCamera);
    let view = toCamera / viewDistance;
    let reflected = reflect(-view, normal);
    let reflection = skyRadianceBlurred(reflected, 4.0 + covariance.x * 40.0, 3.0);
    let lightDirection = atmosphere.lightDirectionAndCameraAltitude.xyz;
    let behind = skyRadianceBlurred(-view * vec3f(1.0, -1.0, 1.0), 6.0, 5.0);
    let thickness = max(world.y, 1.0) * (0.6 + 0.4 * gradientNoiseTwo(world.xz * 0.004));
    let transmission = exp(-vec3f(0.30, 0.05, 0.004) * thickness * 0.02) * pow(max(dot(lightDirection, -view), 0.0), 3.0);
    let streaks = smoothstep(0.55, 0.8, gradientNoiseTwo(vec2f(input.vProfile.y * 0.05, world.y * 0.003)) * 0.5 + 0.5);
    let fresnel = 0.02 + 0.98 * pow(1.0 - max(dot(normal, view), 0.0), 5.0);
    var radiance = vec3f(0.05, 0.07, 0.07) * (1.0 - fresnel) + reflection * fresnel + behind * transmission * vec3f(0.2, 0.9, 0.8) + vec3f(streaks * 0.08);
    let currentClip = frame.viewProjection * vec4f(world, 1.0);
    let previousClip = frame.previousViewProjection * vec4f(world, 1.0);
    radiance = applyAerialPerspective(radiance, currentClip, viewDistance);
    fragmentOutputs.fragData0 = vec4f(radiance, 1.0);
    fragmentOutputs.fragData1 = packMotionDepthAndSurface(currentClip, previousClip, SURFACE_CODE_WAVE);
}
