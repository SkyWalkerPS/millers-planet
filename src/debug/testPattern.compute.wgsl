struct PatternParameters {
    timeSeconds: f32,
    frameIndex: f32,
    heavyIterations: f32,
    solidColourMode: f32,
};

@group(0) @binding(0) var patternTexture: texture_storage_2d<rgba16float, write>;
@group(0) @binding(1) var<uniform> parameters: PatternParameters;

fn hashTwoToOne(cell: vec2u) -> f32 {
    var state = cell.x * 1664525u + cell.y * 1013904223u + 374761393u;
    state = (state ^ (state >> 15u)) * 2246822519u;
    state = (state ^ (state >> 13u)) * 3266489917u;
    state = state ^ (state >> 16u);
    return f32(state) / 4294967295.0;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) invocation: vec3u) {
    let size = textureDimensions(patternTexture);
    if (invocation.x >= size.x || invocation.y >= size.y) {
        return;
    }
    let uv = (vec2f(invocation.xy) + 0.5) / vec2f(size);
    let checker = f32(((invocation.x / 64u) + (invocation.y / 64u)) % 2u);
    let ripple = 0.5 + 0.5 * sin(dot(uv, vec2f(310.0, 170.0)) + parameters.timeSeconds * 2.0);
    let lineX = step(0.94, fract(uv.x * 64.0));
    let lineY = step(0.94, fract(uv.y * 64.0));
    let speckle = hashTwoToOne(invocation.xy / 2u);
    var colour = mix(vec3f(0.16, 0.18, 0.2), vec3f(0.5, 0.47, 0.43), checker);
    colour = colour * (0.8 + 0.2 * ripple) * (0.85 + 0.3 * speckle) + vec3f(0.55) * max(lineX, lineY);
    if (parameters.solidColourMode > 0.5) {
        let channel = u32(parameters.frameIndex) % 3u;
        textureStore(patternTexture, vec2i(invocation.xy), vec4f(select(0.0, 1.0, channel == 0u), select(0.0, 1.0, channel == 1u), select(0.0, 1.0, channel == 2u), 1.0));
        return;
    }
    var extra = 0.0;
    for (var iteration = 0.0; iteration < parameters.heavyIterations; iteration += 1.0) {
        extra += sin(uv.x * iteration + parameters.timeSeconds) * 1e-6;
    }
    textureStore(patternTexture, vec2i(invocation.xy), vec4f(colour + extra, 1.0));
}
