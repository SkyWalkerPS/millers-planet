struct WaveParameters {
    crestAlongHeightEnabled: vec4f,
    towardAndWidths: vec4f,
    previousCrestAlongLateralCentreHalfExtent: vec4f,
    glowAndRaggedness: vec4f,
};

fn waveToward() -> vec2f {
    return waveParameters.towardAndWidths.xy;
}

fn waveLateralDirection() -> vec2f {
    let toward = waveToward();
    return vec2f(toward.y, -toward.x);
}

fn waveFrontWidth() -> f32 {
    return waveParameters.towardAndWidths.z;
}

fn waveBackWidth() -> f32 {
    return waveParameters.towardAndWidths.w;
}

fn waveLocalShape(lateral: f32) -> vec2f {
    let broad = trigonometryFreeGradientNoiseTwo(vec2f(lateral * 0.00055, 4.1));
    let medium = trigonometryFreeGradientNoiseTwo(vec2f(lateral * 0.0021, 9.7));
    let heightScale = 1.0 + 0.07 * broad + 0.025 * medium;
    let crestOffset = 140.0 * trigonometryFreeGradientNoiseTwo(vec2f(lateral * 0.00035, 1.3));
    return vec2f(heightScale, crestOffset);
}

fn waveProfileHeight(x: f32, crestHeight: f32) -> f32 {
    if (x >= 0.0) {
        if (x >= waveFrontWidth()) {
            return -0.6;
        }
        let remaining = 1.0 - x / waveFrontWidth();
        return crestHeight * remaining * remaining;
    }
    if (-x >= waveBackWidth()) {
        return -0.6;
    }
    let remaining = 1.0 + x / waveBackWidth();
    return crestHeight * remaining * remaining;
}

fn waveProfileSlope(x: f32, crestHeight: f32) -> f32 {
    if (x >= 0.0) {
        let remaining = max(1.0 - x / waveFrontWidth(), 0.0);
        return -2.0 * crestHeight * remaining / waveFrontWidth();
    }
    let remaining = max(1.0 + x / waveBackWidth(), 0.0);
    return 2.0 * crestHeight * remaining / waveBackWidth();
}

fn waveCrestChordMetres(depthBelowCrest: f32, crestHeight: f32, rayDirection: vec3f) -> f32 {
    let frontSlope = 2.0 * crestHeight / waveFrontWidth();
    let backSlope = 2.0 * crestHeight / waveBackWidth();
    let intoWave = dot(rayDirection.xz, waveToward());
    let denominator = rayDirection.y + backSlope * max(intoWave, 0.0);
    if (denominator <= 0.02) {
        return 1e4;
    }
    return max(depthBelowCrest, 0.0) * (1.0 + backSlope / frontSlope) / denominator;
}
