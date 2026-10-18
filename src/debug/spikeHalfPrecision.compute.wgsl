enable f16;

@group(0) @binding(0) var<storage, read_write> results: array<f32>;

@compute @workgroup_size(1, 1, 1)
fn main() {
    let halfValue: f16 = 1.5h;
    let squared: f16 = halfValue * halfValue;
    results[0] = f32(squared);
}
