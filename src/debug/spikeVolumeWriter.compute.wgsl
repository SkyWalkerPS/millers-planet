@group(0) @binding(0) var volumeOutput: texture_storage_3d<rgba16float, write>;

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) invocation: vec3u) {
    if (any(invocation >= vec3u(32u))) {
        return;
    }
    textureStore(volumeOutput, invocation, vec4f(f32(invocation.x) / 31.0, f32(invocation.z) / 31.0, 0.25, 1.0));
}
