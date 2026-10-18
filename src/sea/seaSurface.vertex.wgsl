#include<frameUniforms>
#include<seaSurfaceParameters>
#include<clipmapPlacement>

attribute position: vec3f;
var<uniform> frame: FrameUniforms;
var<uniform> seaSurface: SeaSurfaceParameters;
var displacementTexture: texture_2d_array<f32>;
var displacementTextureSampler: sampler;
var rippleTexture: texture_2d<f32>;
var rippleTextureSampler: sampler;
varying vWorldPosition: vec3f;
varying vLagrangian: vec2f;

fn rippleHeightAt(world: vec2f, spacing: f32) -> f32 {
    let fade = rippleWindowFade(world);
    if (fade <= 0.0) {
        return 0.0;
    }
    let period = 2.0 * seaSurface.rippleWindowCentreHalfTexel.z;
    let uv = world / period;
    let tap = max(spacing, seaSurface.rippleWindowCentreHalfTexel.w) / period;
    var height = 0.0;
    for (var row = -1; row <= 1; row++) {
        for (var column = -1; column <= 1; column++) {
            let weight = f32((2 - abs(column)) * (2 - abs(row))) / 16.0;
            height += weight * textureSampleLevel(rippleTexture, rippleTextureSampler, uv + vec2f(f32(column), f32(row)) * tap, 0.0).x;
        }
    }
    return height * fade * (1.0 - smoothstep(0.1, 0.2, spacing));
}

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    let grid = vec2f(vertexInputs.position.x, vertexInputs.position.z);
    let placement = placeClipmapVertex(grid, vertexInputs.position.y, seaSurface.clipmapCentreAndSpacing.xy, seaSurface.clipmapCentreAndSpacing.z, seaSurface.clipmapCentreAndSpacing.w);
    let lagrangian = placement.worldXZ;
    let fromCamera = lagrangian - frame.cameraPositionAndTime.xz;
    let distanceToCamera = length(fromCamera);
    let shape = seaSurface.displacementFadeLevelCurvature;
    let fade = 1.0 - smoothstep(shape.x, shape.y, distanceToCamera);
    var displacement = vec3f(0.0);
    if (fade > 0.0) {
        for (var cascade = 0u; cascade < 3u; cascade++) {
            let texelSize = seaSurface.cascadeSizes[cascade] / 256.0;
            let level = log2(max(placement.spacing / texelSize, 1.0)) + 0.5;
            if (level < 8.0) {
                displacement += textureSampleLevel(displacementTexture, displacementTextureSampler, lagrangian * seaSurface.cascadeInverseSizes[cascade] + cascadeOriginUvOffset(cascade), cascade, level).xyz;
            }
        }
        displacement *= fade;
    }
    displacement.y += rippleHeightAt(lagrangian, placement.spacing);
    let curvatureDrop = dot(fromCamera, fromCamera) / (2.0 * shape.w);
    let world = vec3f(lagrangian.x + displacement.x, shape.z + seaSurface.drainLevelFoamFlow.x + displacement.y - curvatureDrop, lagrangian.y + displacement.z);
    vertexOutputs.position = frame.jitteredViewProjection * vec4f(world, 1.0);
    vertexOutputs.vWorldPosition = world;
    vertexOutputs.vLagrangian = lagrangian;
}
