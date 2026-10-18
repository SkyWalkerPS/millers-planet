#include<frameUniforms>

attribute position: vec3f;
uniform world: mat4x4f;
var<uniform> frame: FrameUniforms;
varying vCurrentClip: vec4f;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    let worldPosition = (uniforms.world * vec4f(vertexInputs.position, 1.0)).xyz;
    vertexOutputs.position = frame.jitteredViewProjection * vec4f(worldPosition, 1.0);
    vertexOutputs.vCurrentClip = frame.viewProjection * vec4f(worldPosition, 1.0);
}
