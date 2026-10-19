fn waveCoverageFromNearFace(origin: vec3f, direction: vec3f, toward: vec2f, crestAlong: f32, crestHeight: f32, nearFaceWidth: f32) -> vec4f {
    let alongRate = dot(direction.xz, toward);
    if (alongRate <= 1e-4) {
        return vec4f(0.0);
    }
    let frontOfCrest = crestAlong - dot(origin.xz, toward);
    if (frontOfCrest <= 0.0) {
        return vec4f(0.0);
    }
    if (direction.y < 0.0 && max(origin.y, 0.0) / -direction.y < (frontOfCrest - nearFaceWidth) / alongRate) {
        return vec4f(0.0);
    }
    let distanceToCrest = frontOfCrest / alongRate;
    let rayHeightAtCrest = origin.y + distanceToCrest * direction.y;
    let below = crestHeight - rayHeightAtCrest;
    let softness = 4.0 + distanceToCrest * 0.004;
    let coverage = smoothstep(-softness, softness, below);
    let glow = coverage * (1.0 - smoothstep(0.0, 220.0 + distanceToCrest * 0.05, below));
    let linearTerm = direction.y * nearFaceWidth / alongRate;
    let constantTerm = origin.y + direction.y * (frontOfCrest - nearFaceWidth) / alongRate;
    let discriminant = linearTerm * linearTerm + 4.0 * crestHeight * constantTerm;
    var remaining = 1.0;
    if (discriminant >= 0.0) {
        remaining = clamp((linearTerm + sqrt(discriminant)) / (2.0 * crestHeight), 0.0, 1.0);
    }
    return vec4f(coverage, remaining * remaining, glow, distanceToCrest);
}

fn waveCoverageInDirection(origin: vec3f, direction: vec3f) -> vec4f {
    let approaching = waveParameters.crestAlongHeightEnabled;
    if (approaching.z < 0.5 || approaching.y < 1.0) {
        return vec4f(0.0);
    }
    return waveCoverageFromNearFace(origin, direction, waveToward(), approaching.x, approaching.y, waveFrontWidth());
}

fn recedingWaveCoverageInDirection(origin: vec3f, direction: vec3f) -> vec4f {
    let receding = waveParameters.recedingCrestAlongHeightEnabled;
    if (receding.z < 0.5 || receding.y < 1.0) {
        return vec4f(0.0);
    }
    return waveCoverageFromNearFace(origin, direction, -waveToward(), -receding.x, receding.y, waveBackWidth());
}

fn applyWaveCoverage(radiance: vec3f, cover: vec4f, crestHeight: f32, glowScale: f32, origin: vec3f, direction: vec3f, skyIrradiance: vec3f, skyLevel: f32) -> vec3f {
    if (cover.x <= 0.0) {
        return radiance;
    }
    let body = skyIrradiance * vec3f(0.012, 0.048, 0.056) * (0.75 / ATMOSPHERE_PI);
    let mist = skyIrradiance * (0.62 / ATMOSPHERE_PI);
    let face = mix(mist, body, smoothstep(0.0, 0.05, cover.y));
    let hazeAmount = (1.0 - exp(-cover.w / 9000.0)) * WAVE_HAZE_KEPT;
    let hazyFace = mix(face, radiance * frame.waveLightingAndHaze.z, hazeAmount);
    let glowStrength = 2.2 * cover.z * (1.0 - hazeAmount) * glowScale;
    var glow = vec3f(0.0);
    if (glowStrength > 0.001) {
        let horizontal = normalize(vec3f(direction.x, 0.0, direction.z));
        let crestElevation = atan2(crestHeight - origin.y, cover.w);
        let crestDirection = normalize(horizontal * cos(crestElevation) + vec3f(0.0, sin(crestElevation) + 0.01, 0.0));
        let behindCrest = skyRadianceBlurred(crestDirection, max(skyLevel, 3.0), max(skyLevel, 3.0));
        glow = behindCrest * vec3f(0.22, 0.78, 0.74) * glowStrength;
    }
    return mix(radiance, hazyFace, cover.x) + glow;
}

fn applyWaveToReflection(radiance: vec3f, origin: vec3f, direction: vec3f, skyIrradiance: vec3f, skyLevel: f32) -> vec3f {
    let withApproaching = applyWaveCoverage(radiance, waveCoverageInDirection(origin, direction), waveParameters.crestAlongHeightEnabled.y, 1.0, origin, direction, skyIrradiance, skyLevel);
    return applyWaveCoverage(withApproaching, recedingWaveCoverageInDirection(origin, direction), waveParameters.recedingCrestAlongHeightEnabled.y, 0.0, origin, direction, skyIrradiance, skyLevel);
}
