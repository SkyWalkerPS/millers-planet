#include<gargantuaUniformStruct>

struct PatchSlice {
    sliceIndex: f32,
    sliceCount: f32,
    debugHeatMap: f32,
    unusedPadding: f32,
};

@group(0) @binding(0) var<storage, read> frame: GargantuaUniforms;
@group(0) @binding(1) var repeatSampler: sampler;
@group(0) @binding(2) var diskNoiseTexture: texture_2d<f32>;
@group(0) @binding(3) var blackbodyTable: texture_2d<f32>;
@group(0) @binding(4) var patchOutput: texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var<uniform> patchSlice: PatchSlice;

#include<gargantuaIntegrator>

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) invocation: vec3u) {
    let patchSize = vec2u(frame.internalSize);
    let row = invocation.y * u32(patchSlice.sliceCount) + u32(patchSlice.sliceIndex);
    if (invocation.x >= patchSize.x || row >= patchSize.y) {
        return;
    }
    let pixelCentre = vec2f(f32(invocation.x) + 0.5, f32(row) + 0.5);
    let result = traceRay(localRayDirection(pixelCentre), true, 1.0);
    let escaped = result.outcome == OUTCOME_ESCAPED;
    var emission = result.emission;
    var visibility = select(0.0, result.transmittance, escaped);
    if (result.steps > SUPERSAMPLE_STEP_THRESHOLD) {
        for (var sampleIndex = 0u; sampleIndex < 4u; sampleIndex++) {
            let extra = traceRay(localRayDirection(pixelCentre + supersampleOffset(sampleIndex)), true, 1.0);
            emission += extra.emission;
            visibility += select(0.0, extra.transmittance, extra.outcome == OUTCOME_ESCAPED);
        }
        emission *= 0.2;
        visibility *= 0.2;
    }
    var texel = vec4f(emission, visibility);
    if (patchSlice.debugHeatMap > 0.5) {
        texel = vec4f(heatColor(f32(result.steps) / 160.0), 0.0);
    }
    textureStore(patchOutput, vec2i(i32(invocation.x), i32(row)), texel);
}
