#include<frameUniforms>
#include<beautyOutputs>

var<uniform> frame: FrameUniforms;
var patternTexture: texture_2d<f32>;
var patternTextureSampler: sampler;
uniform albedoTint: vec4f;
uniform patternMetresPerRepeat: f32;
varying vWorldPosition: vec3f;
varying vWorldNormal: vec3f;
varying vCurrentClip: vec4f;
varying vPreviousClip: vec4f;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let normal = normalize(input.vWorldNormal);
    let planarCoordinates = select(input.vWorldPosition.xz, input.vWorldPosition.xy + input.vWorldPosition.zz, abs(normal.y) < 0.5);
    let pattern = textureSample(patternTexture, patternTextureSampler, planarCoordinates / uniforms.patternMetresPerRepeat).rgb;
    let albedo = pattern * uniforms.albedoTint.rgb;
    let lightDirection = frame.keyLightDirectionAndAngularRadius.xyz;
    let diffuse = max(dot(normal, lightDirection), 0.0);
    let ambient = vec3f(0.42, 0.4, 0.38) * (0.6 + 0.4 * normal.y);
    let radiance = albedo * (ambient + frame.keyLightRadianceAndFrameIndex.xyz * 0.0008 * diffuse);
    let viewDistance = length(input.vWorldPosition - frame.cameraPositionAndTime.xyz);
    let haze = 1.0 - exp(-viewDistance / 900.0);
    let hazed = mix(radiance, vec3f(1.05, 0.96, 0.84), haze);
    fragmentOutputs.fragData0 = vec4f(hazed, 1.0);
    fragmentOutputs.fragData1 = packMotionDepthAndSurface(input.vCurrentClip, input.vPreviousClip, SURFACE_CODE_SOLID);
}
