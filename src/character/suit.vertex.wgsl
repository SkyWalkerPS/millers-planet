#include<frameUniforms>
#include<suitSkin>

attribute position: vec3f;
attribute normal: vec3f;
attribute uv: vec2f;
attribute suitAux: vec2f;
attribute suitBones: vec4f;
attribute suitWeights: vec4f;
var<uniform> frame: FrameUniforms;
var suitBoneTexture: texture_2d<f32>;
var suitBoneTextureSampler: sampler;
varying vWorldPosition: vec3f;
varying vWorldNormal: vec3f;
varying vSurfaceUv: vec2f;
varying vAux: vec2f;
varying vBindPosition: vec3f;
varying vCurrentClip: vec4f;
varying vPreviousClip: vec4f;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    let bones = vertexInputs.suitBones;
    let weights = vertexInputs.suitWeights;
    let world = skinPoint(bones, weights, 0, vertexInputs.position);
    let previousWorld = skinPoint(bones, weights, 4, vertexInputs.position);
    vertexOutputs.position = frame.jitteredViewProjection * vec4f(world, 1.0);
    vertexOutputs.vCurrentClip = frame.viewProjection * vec4f(world, 1.0);
    vertexOutputs.vPreviousClip = frame.previousViewProjection * vec4f(previousWorld, 1.0);
    vertexOutputs.vWorldPosition = world;
    vertexOutputs.vWorldNormal = skinDirection(bones, weights, 0, vertexInputs.normal);
    vertexOutputs.vSurfaceUv = vertexInputs.uv;
    vertexOutputs.vAux = vertexInputs.suitAux;
    vertexOutputs.vBindPosition = vertexInputs.position;
}
