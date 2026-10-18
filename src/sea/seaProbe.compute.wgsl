struct SeaProbeParameters {
    countModeUnused: vec4f,
    cascadeInverseSizes: vec4f,
};

@group(0) @binding(0) var<uniform> probe: SeaProbeParameters;
@group(0) @binding(1) var displacementTexture: texture_2d_array<f32>;
@group(0) @binding(2) var<storage, read> queries: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> results: array<vec4f>;
@group(0) @binding(4) var repeatSampler: sampler;

fn displacementAt(lagrangianPosition: vec2f) -> vec3f {
    var total = vec3f(0.0);
    for (var cascade = 0u; cascade < 3u; cascade++) {
        let uv = lagrangianPosition * probe.cascadeInverseSizes[cascade];
        total += textureSampleLevel(displacementTexture, repeatSampler, uv, cascade, 0.0).xyz;
    }
    return total;
}

@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) invocation: vec3u) {
    let index = invocation.x;
    if (index >= u32(probe.countModeUnused.x)) {
        return;
    }
    let query = queries[index];
    if (probe.countModeUnused.y < 0.5) {
        results[index] = textureLoad(displacementTexture, vec2i(query.xy), u32(query.z), 0);
        return;
    }
    let targetPosition = query.xy;
    var lagrangian = targetPosition;
    for (var iteration = 0; iteration < 4; iteration++) {
        let displacement = displacementAt(lagrangian);
        lagrangian = targetPosition - displacement.xz;
    }
    let displacement = displacementAt(lagrangian);
    results[index] = vec4f(displacement.y, lagrangian, 0.0);
}
