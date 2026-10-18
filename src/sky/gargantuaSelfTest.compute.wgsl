#include<gargantuaUniformStruct>

struct SelfTestRecord {
    summary: vec4f,
    sky: vec4f,
    crossing: vec4f,
};

@group(0) @binding(0) var<storage, read> frame: GargantuaUniforms;
@group(0) @binding(1) var repeatSampler: sampler;
@group(0) @binding(2) var diskNoiseTexture: texture_2d<f32>;
@group(0) @binding(3) var blackbodyTable: texture_2d<f32>;
@group(0) @binding(4) var<storage, read> selfTestDirections: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> selfTestRecords: array<SelfTestRecord>;

#include<gargantuaIntegrator>

@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) invocation: vec3u) {
    if (invocation.x >= arrayLength(&selfTestDirections)) {
        return;
    }
    let result = traceRay(selfTestDirections[invocation.x].xyz, false, 1.0);
    selfTestRecords[invocation.x].summary = vec4f(f32(result.outcome), f32(result.steps), f32(result.crossings), result.skyRedshift);
    selfTestRecords[invocation.x].sky = vec4f(result.skyDirection, 0.0);
    selfTestRecords[invocation.x].crossing = result.firstCrossing;
}
