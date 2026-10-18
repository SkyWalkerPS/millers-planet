/*
 * Derived from web-ocean by Maksymilian Dendura (Noniv): https://github.com/Noniv/web-ocean
 * Copyright (c) 2026 Maksymilian Dendura. MIT License; full text in LICENSE.
 */

#include<atmosphereCore>

@group(0) @binding(0) var<uniform> atmosphere: AtmosphereParameters;
@group(0) @binding(1) var transmittanceOutput: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) invocation: vec3u) {
    if (f32(invocation.x) >= TRANSMITTANCE_LUT_WIDTH || f32(invocation.y) >= TRANSMITTANCE_LUT_HEIGHT) {
        return;
    }
    let parameters = atmosphere;
    let uv = (vec2f(invocation.xy) + 0.5) / vec2f(TRANSMITTANCE_LUT_WIDTH, TRANSMITTANCE_LUT_HEIGHT);
    let radiusAndCosine = transmittanceUvToRadiusCosine(uv, parameters);
    let origin = vec3f(0.0, radiusAndCosine.x, 0.0);
    let direction = vec3f(sqrt(max(0.0, 1.0 - radiusAndCosine.y * radiusAndCosine.y)), radiusAndCosine.y, 0.0);
    let distanceToTop = raySphereIntersection(origin, direction, topRadius(parameters)).y;
    var opticalDepth = vec3f(0.0);
    let stepCount = 64u;
    let stepLength = distanceToTop / f32(stepCount);
    for (var stepIndex = 0u; stepIndex < stepCount; stepIndex++) {
        let samplePoint = origin + direction * ((f32(stepIndex) + 0.5) * stepLength);
        opticalDepth += atmosphereMedium(length(samplePoint) - groundRadius(parameters), parameters).extinction * stepLength;
    }
    textureStore(transmittanceOutput, invocation.xy, vec4f(exp(-opticalDepth), 1.0));
}
