#include<frameUniforms>
#include<beautyOutputs>

var<uniform> frame: FrameUniforms;
varying vScreenNdc: vec2f;

fn skyRadiance(direction: vec3f) -> vec3f {
    let elevation = direction.y;
    let horizonColour = vec3f(1.15, 1.02, 0.86);
    let zenithColour = vec3f(0.62, 0.6, 0.58);
    var radiance = mix(horizonColour, zenithColour, smoothstep(-0.02, 0.7, elevation));
    radiance = select(radiance, vec3f(0.08, 0.085, 0.09), elevation < -0.02);
    let lightDirection = frame.keyLightDirectionAndAngularRadius.xyz;
    let angularRadius = frame.keyLightDirectionAndAngularRadius.w;
    let cosineToLight = dot(direction, lightDirection);
    let angleToLight = acos(clamp(cosineToLight, -1.0, 1.0));
    let disc = 1.0 - smoothstep(angularRadius * 0.92, angularRadius, angleToLight);
    let halo = exp(-angleToLight * 7.0) * 1.5;
    radiance += frame.keyLightRadianceAndFrameIndex.xyz * disc + vec3f(1.0, 0.92, 0.8) * halo;
    return radiance;
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let unjitteredNdc = input.vScreenNdc - frame.jitterNdcAndInternalSize.xy;
    let pointOnNearPlane = frame.inverseViewProjection * vec4f(unjitteredNdc, 1.0, 1.0);
    let direction = normalize(pointOnNearPlane.xyz / pointOnNearPlane.w - frame.cameraPositionAndTime.xyz);
    let previousClip = frame.previousViewProjection * vec4f(direction, 0.0);
    let currentClip = frame.viewProjection * vec4f(direction, 0.0);
    let motion = screenMotionFromClipPositions(currentClip, previousClip);
    fragmentOutputs.fragData0 = vec4f(skyRadiance(direction), 1.0);
    fragmentOutputs.fragData1 = vec4f(motion, SKY_VIEW_DEPTH_METRES, SURFACE_CODE_SKY);
}
