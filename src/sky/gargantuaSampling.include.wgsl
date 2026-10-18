fn gargantuaPatchCoordinates(direction: vec3f) -> vec3f {
    let depthAlongForward = dot(direction, frame.gargantuaForwardAndTanHalfX.xyz);
    if (depthAlongForward <= 1e-4) {
        return vec3f(0.0, 0.0, 0.0);
    }
    let horizontal = dot(direction, frame.gargantuaRightAndTanHalfY.xyz) / (depthAlongForward * frame.gargantuaForwardAndTanHalfX.w);
    let vertical = dot(direction, frame.gargantuaUpAndCrossfade.xyz) / (depthAlongForward * frame.gargantuaRightAndTanHalfY.w);
    let inside = select(0.0, 1.0, abs(horizontal) < 1.0 && abs(vertical) < 1.0);
    return vec3f(0.5 + 0.5 * horizontal, 0.5 - 0.5 * vertical, inside);
}

fn sampleGargantua(direction: vec3f, level: f32) -> vec4f {
    let coordinates = gargantuaPatchCoordinates(direction);
    if (coordinates.z < 0.5) {
        return vec4f(0.0, 0.0, 0.0, 1.0);
    }
    let previous = textureSampleLevel(gargantuaPreviousPatch, gargantuaPreviousPatchSampler, coordinates.xy, level);
    let current = textureSampleLevel(gargantuaCurrentPatch, gargantuaCurrentPatchSampler, coordinates.xy, level);
    let blended = mix(previous, current, frame.gargantuaUpAndCrossfade.w);
    return vec4f(blended.rgb * frame.gargantuaRadianceScaleAndShadowStrength.x, blended.a);
}
