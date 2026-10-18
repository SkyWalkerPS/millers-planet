attribute position: vec3f;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    vertexOutputs.position = vec4f(vertexInputs.position.xy, 0.5, 1.0);
}
