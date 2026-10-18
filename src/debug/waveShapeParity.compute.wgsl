#include<proceduralNoise>
#include<waveShape>

@group(0) @binding(0) var<storage, read> lateralMetres: array<f32>;
@group(0) @binding(1) var<storage, read_write> localShapes: array<vec2f>;
@group(0) @binding(2) var<uniform> waveParameters: WaveParameters;

@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) invocation: vec3u) {
    let index = invocation.x;
    if (index >= arrayLength(&lateralMetres)) {
        return;
    }
    localShapes[index] = waveLocalShape(lateralMetres[index]);
}
