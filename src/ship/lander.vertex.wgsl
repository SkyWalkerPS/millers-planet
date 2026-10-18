#include<frameUniforms>

attribute position: vec3f;
attribute normal: vec3f;
attribute uv: vec2f;
attribute landerAux: vec2f;
uniform world: mat4x4f;
uniform previousWorld: mat4x4f;
uniform damageAndWaterLevel: vec4f;
var<uniform> frame: FrameUniforms;
varying vWorldPosition: vec3f;
varying vWorldNormal: vec3f;
varying vSurfaceUv: vec2f;
varying vAux: vec2f;
varying vCurrentClip: vec4f;
varying vPreviousClip: vec4f;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    let worldPosition = (uniforms.world * vec4f(vertexInputs.position, 1.0)).xyz;
    let previousWorldPosition = (uniforms.previousWorld * vec4f(vertexInputs.position, 1.0)).xyz;
    vertexOutputs.position = frame.jitteredViewProjection * vec4f(worldPosition, 1.0);
    vertexOutputs.vCurrentClip = frame.viewProjection * vec4f(worldPosition, 1.0);
    vertexOutputs.vPreviousClip = frame.previousViewProjection * vec4f(previousWorldPosition, 1.0);
    vertexOutputs.vWorldPosition = worldPosition;
    vertexOutputs.vWorldNormal = normalize((uniforms.world * vec4f(vertexInputs.normal, 0.0)).xyz);
    vertexOutputs.vSurfaceUv = vertexInputs.uv;
    vertexOutputs.vAux = vertexInputs.landerAux;
}
