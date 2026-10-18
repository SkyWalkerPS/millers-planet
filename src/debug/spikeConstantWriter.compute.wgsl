struct ConstantWriterParameters {
    value: f32,
    slot: f32,
    unusedA: f32,
    unusedB: f32,
};

@group(0) @binding(0) var<uniform> parameters: ConstantWriterParameters;
@group(0) @binding(1) var<storage, read_write> results: array<f32>;

@compute @workgroup_size(1, 1, 1)
fn main() {
    results[u32(parameters.slot)] = parameters.value;
}
