/*
 * Derived from snowflow_demo by Maksymilian Dendura (Noniv): https://github.com/Noniv/snowflow_demo
 * Copyright (c) 2026 Maksymilian Dendura. MIT License; full text in LICENSE.
 */

fn suitBoneColumn(bone: i32, column: i32, rowOffset: i32) -> vec4f {
    return textureLoad(suitBoneTexture, vec2i(bone, rowOffset + column), 0);
}

fn skinPointWithBone(bone: i32, rowOffset: i32, point: vec3f) -> vec3f {
    return suitBoneColumn(bone, 0, rowOffset).xyz * point.x + suitBoneColumn(bone, 1, rowOffset).xyz * point.y + suitBoneColumn(bone, 2, rowOffset).xyz * point.z + suitBoneColumn(bone, 3, rowOffset).xyz;
}

fn skinDirectionWithBone(bone: i32, rowOffset: i32, direction: vec3f) -> vec3f {
    return suitBoneColumn(bone, 0, rowOffset).xyz * direction.x + suitBoneColumn(bone, 1, rowOffset).xyz * direction.y + suitBoneColumn(bone, 2, rowOffset).xyz * direction.z;
}

fn skinPoint(bones: vec4f, weights: vec4f, rowOffset: i32, point: vec3f) -> vec3f {
    var result = skinPointWithBone(i32(bones.x + 0.5), rowOffset, point) * weights.x;
    if (weights.y > 0.0001) {
        result += skinPointWithBone(i32(bones.y + 0.5), rowOffset, point) * weights.y;
    }
    return result / max(1e-4, weights.x + weights.y);
}

fn skinDirection(bones: vec4f, weights: vec4f, rowOffset: i32, direction: vec3f) -> vec3f {
    var result = skinDirectionWithBone(i32(bones.x + 0.5), rowOffset, direction) * weights.x;
    if (weights.y > 0.0001) {
        result += skinDirectionWithBone(i32(bones.y + 0.5), rowOffset, direction) * weights.y;
    }
    return normalize(result);
}
