#include<frameUniforms>
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
varying vScreenNdc: vec2f;

#include<gargantuaSampling>
#include<skyComposite>

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let pointAtInfinity = frame.inverseViewProjection * vec4f(input.vScreenNdc, 0.0, 1.0);
    let direction = normalize(pointAtInfinity.xyz);
    let time = frame.cameraPositionAndTime.w;
    var window = vec3f(0.0);
    for (var tap = 0; tap < 4; tap++) {
        let wobble = vec2f(gradientNoiseTwo(direction.xz * 9.0 + vec2f(f32(tap) * 3.1, time)), gradientNoiseTwo(direction.xz * 9.0 + vec2f(time, f32(tap) * 1.7))) * 0.05;
        let refracted = refract(normalize(direction + vec3f(wobble.x, 0.0, wobble.y)), vec3f(0.0, -1.0, 0.0), 1.333);
        window += skyRadianceBlurred(normalize(refracted + vec3f(0.0, 0.001, 0.0)), 2.0, 2.0);
    }
    let bubbles = smoothstep(0.92, 0.98, gradientNoiseTwo(input.vScreenNdc * 40.0 + vec2f(0.0, time * 2.0)) * 0.5 + 0.5);
    let shafts = gradientNoiseTwo(vec2f(input.vScreenNdc.x * 6.0 + time * 0.3, 0.0)) * 0.5 + 0.5;
    let medium = vec3f(0.02, 0.07, 0.065) * (1.0 + shafts);
    let underwater = mix(medium, window * 0.25, 0.3) + vec3f(bubbles * 0.2);
    fragmentOutputs.fragData0 = vec4f(underwater, waveReservation.underwaterStrength.x);
    fragmentOutputs.fragData1 = vec4f(0.0);
}
