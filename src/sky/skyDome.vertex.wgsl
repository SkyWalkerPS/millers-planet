attribute position: vec3f;
varying vScreenNdc: vec2f;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    vertexOutputs.position = vec4f(vertexInputs.position.xy, 0.0, 1.0);
    vertexOutputs.vScreenNdc = vertexInputs.position.xy;
}
