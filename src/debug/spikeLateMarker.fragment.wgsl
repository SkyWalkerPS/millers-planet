#include<beautyOutputs>

uniform markerColour: vec4f;
varying vCurrentClip: vec4f;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
#ifdef LATE_MARKER_UNWARMED
    let colour = uniforms.markerColour.rgb * 0.5;
#else
    let colour = uniforms.markerColour.rgb;
#endif
    fragmentOutputs.fragData0 = vec4f(colour, 1.0);
    fragmentOutputs.fragData1 = packMotionDepthAndSurface(input.vCurrentClip, input.vCurrentClip, SURFACE_CODE_SOLID);
}
