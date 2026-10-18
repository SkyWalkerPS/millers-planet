const RIPPLE_RESOLUTION: i32 = 512;
const KERNEL_RADIUS: i32 = 6;
const KERNEL_SIDE: i32 = 13;
const TILE_EDGE: i32 = 16;
const TILE_WITH_APRON: i32 = 28;
const MAXIMUM_STAMPS: u32 = 32u;

struct RippleStepParameters {
    windowLowAndPreviousLow: vec4f,
    updateCoefficients: vec4f,
    spongeAndCounts: vec4f,
    texelSizeAndUnused: vec4f,
};

struct RippleStamp {
    positionRadiusElongation: vec4f,
    forwardHeightFoam: vec4f,
    ringWeightAndUnused: vec4f,
};

@group(0) @binding(0) var<uniform> parameters: RippleStepParameters;
@group(0) @binding(1) var<storage, read> kernelWeights: array<f32>;
@group(0) @binding(2) var<storage, read> stamps: array<RippleStamp>;
@group(0) @binding(3) var previousState: texture_2d<f32>;
@group(0) @binding(4) var nextState: texture_storage_2d<rgba16float, write>;

var<workgroup> tileHeights: array<f32, 784>;

fn wrappedIndex(index: vec2i) -> vec2i {
    return (index % vec2i(RIPPLE_RESOLUTION) + vec2i(RIPPLE_RESOLUTION)) % vec2i(RIPPLE_RESOLUTION);
}

fn worldTexelOf(storageIndex: vec2i, windowLow: vec2i) -> vec2i {
    return windowLow + wrappedIndex(storageIndex - windowLow);
}

fn insidePreviousWindow(worldTexel: vec2i) -> bool {
    let previousLow = vec2i(parameters.windowLowAndPreviousLow.zw);
    return all(worldTexel >= previousLow) && all(worldTexel < previousLow + vec2i(RIPPLE_RESOLUTION));
}

fn validHeight(storageIndex: vec2i, windowLow: vec2i) -> vec2f {
    let wrapped = wrappedIndex(storageIndex);
    if (!insidePreviousWindow(worldTexelOf(wrapped, windowLow))) {
        return vec2f(0.0);
    }
    return textureLoad(previousState, wrapped, 0).xy;
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(workgroup_id) workgroup: vec3u, @builtin(local_invocation_id) local: vec3u, @builtin(local_invocation_index) localIndex: u32) {
    let windowLow = vec2i(parameters.windowLowAndPreviousLow.xy);
    let tileOrigin = vec2i(workgroup.xy) * TILE_EDGE - vec2i(KERNEL_RADIUS);
    for (var loadIndex = i32(localIndex); loadIndex < TILE_WITH_APRON * TILE_WITH_APRON; loadIndex += 256) {
        let tileTexel = vec2i(loadIndex % TILE_WITH_APRON, loadIndex / TILE_WITH_APRON);
        tileHeights[loadIndex] = validHeight(tileOrigin + tileTexel, windowLow).x;
    }
    workgroupBarrier();
    let storageIndex = vec2i(workgroup.xy) * TILE_EDGE + vec2i(local.xy);
    let worldTexel = worldTexelOf(storageIndex, windowLow);
    let centre = validHeight(storageIndex, windowLow);
    var operatorSum = 0.0;
    for (var offsetZ = 0; offsetZ < KERNEL_SIDE; offsetZ++) {
        for (var offsetX = 0; offsetX < KERNEL_SIDE; offsetX++) {
            let tileIndex = (i32(local.y) + offsetZ) * TILE_WITH_APRON + (i32(local.x) + offsetX);
            operatorSum += kernelWeights[offsetZ * KERNEL_SIDE + offsetX] * tileHeights[tileIndex];
        }
    }
    let coefficients = parameters.updateCoefficients;
    let fromCentre = worldTexel - windowLow - vec2i(RIPPLE_RESOLUTION / 2);
    let windowFraction = f32(max(abs(fromCentre.x), abs(fromCentre.y))) / f32(RIPPLE_RESOLUTION / 2);
    let sponge = smoothstep(parameters.spongeAndCounts.x, parameters.spongeAndCounts.y, windowFraction);
    var nextHeight = centre.x * coefficients.x - centre.y * coefficients.y - coefficients.z * operatorSum;
    nextHeight = mix(nextHeight, centre.x, sponge * 0.25) * (1.0 - sponge * 0.08);
    var foam = 0.0;
    if (insidePreviousWindow(worldTexel)) {
        foam = textureLoad(previousState, wrappedIndex(storageIndex), 0).z * coefficients.w;
    }
    let texelSize = parameters.texelSizeAndUnused.x;
    let texelLocal = (vec2f(fromCentre) + 0.5) * texelSize;
    let stampCount = min(u32(parameters.spongeAndCounts.w), MAXIMUM_STAMPS);
    for (var stampIndex = 0u; stampIndex < stampCount; stampIndex++) {
        let stamp = stamps[stampIndex];
        let shape = stamp.positionRadiusElongation;
        let motion = stamp.forwardHeightFoam;
        let offset = texelLocal - shape.xy;
        let reach = shape.z * max(shape.w, 1.0) * 1.6;
        if (any(abs(offset) > vec2f(reach))) {
            continue;
        }
        let forward = motion.xy;
        let right = vec2f(forward.y, -forward.x);
        let stampSpace = vec2f(dot(offset, forward) / (shape.z * max(shape.w, 1e-3)), dot(offset, right) / shape.z);
        let radial = length(stampSpace);
        let core = 1.0 - smoothstep(0.42, 1.0, radial);
        let ringDistance = (radial - 1.04) * 3.4;
        let ring = exp(-ringDistance * ringDistance);
        nextHeight += motion.z * (stamp.ringWeightAndUnused.x * ring - core);
        foam = max(foam, motion.w * core);
    }
    textureStore(nextState, storageIndex, vec4f(nextHeight, centre.x, foam, 0.0));
}
