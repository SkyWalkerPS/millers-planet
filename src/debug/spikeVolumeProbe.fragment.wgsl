#include<beautyOutputs>

var probeVolume: texture_3d<f32>;
var probeVolumeSampler: sampler;
uniform sliceCoordinate: f32;
varying vScreenNdc: vec2f;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let screenU = input.vScreenNdc.x * 0.5 + 0.5;
    let sampled = textureSampleLevel(probeVolume, probeVolumeSampler, vec3f(screenU, 0.5, uniforms.sliceCoordinate), 0.0);
    fragmentOutputs.fragData0 = vec4f(sampled.rgb, 1.0);
    fragmentOutputs.fragData1 = vec4f(0.0, 0.0, SKY_VIEW_DEPTH_METRES, SURFACE_CODE_SKY);
}
