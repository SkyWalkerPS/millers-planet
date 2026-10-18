fn waveCoverageInDirection(origin: vec3f, direction: vec3f) -> vec4f {
    if (waveParameters.crestAlongHeightEnabled.z < 0.5) {
        return vec4f(0.0);
    }
    let toward = waveToward();
    let alongRate = dot(direction.xz, toward);
    if (alongRate <= 1e-4) {
        return vec4f(0.0);
    }
    let frontOfCrest = waveParameters.crestAlongHeightEnabled.x - dot(origin.xz, toward);
    if (frontOfCrest <= 0.0) {
        return vec4f(0.0);
    }
    let crestHeight = waveParameters.crestAlongHeightEnabled.y;
    if (direction.y < 0.0 && max(origin.y, 0.0) / -direction.y < (frontOfCrest - waveFrontWidth()) / alongRate) {
        return vec4f(0.0);
    }
    let distanceToCrest = frontOfCrest / alongRate;
    let rayHeightAtCrest = origin.y + distanceToCrest * direction.y;
    let below = crestHeight - rayHeightAtCrest;
    let softness = 4.0 + distanceToCrest * 0.004;
    let coverage = smoothstep(-softness, softness, below);
    let glow = coverage * (1.0 - smoothstep(0.0, 220.0 + distanceToCrest * 0.05, below));
    let frontWidth = waveFrontWidth();
    let linearTerm = direction.y * frontWidth / alongRate;
    let constantTerm = origin.y + direction.y * (frontOfCrest - frontWidth) / alongRate;
    let discriminant = linearTerm * linearTerm + 4.0 * crestHeight * constantTerm;
    var remaining = 1.0;
    if (discriminant >= 0.0) {
        remaining = clamp((linearTerm + sqrt(discriminant)) / (2.0 * crestHeight), 0.0, 1.0);
    }
    return vec4f(coverage, remaining * remaining, glow, distanceToCrest);
}

fn applyWaveToReflection(radiance: vec3f, origin: vec3f, direction: vec3f, skyIrradiance: vec3f, skyLevel: f32) -> vec3f {
    let cover = waveCoverageInDirection(origin, direction);
    if (cover.x <= 0.0) {
        return radiance;
    }
    let body = skyIrradiance * vec3f(0.026, 0.040, 0.038) * (0.75 / ATMOSPHERE_PI);
    let mist = skyIrradiance * (0.62 / ATMOSPHERE_PI);
    let face = mix(mist, body, smoothstep(0.0, 0.05, cover.y));
    let horizontal = normalize(vec3f(direction.x, 0.0, direction.z));
    let crestElevation = atan2(waveParameters.crestAlongHeightEnabled.y - origin.y, cover.w);
    let crestDirection = normalize(horizontal * cos(crestElevation) + vec3f(0.0, sin(crestElevation) + 0.01, 0.0));
    let behindCrest = skyRadianceBlurred(crestDirection, max(skyLevel, 3.0), max(skyLevel, 3.0));
    let hazeAmount = 1.0 - exp(-cover.w / 9000.0);
    let horizon = skyRadianceBlurred(normalize(horizontal + vec3f(0.0, 0.03, 0.0)), 5.0, 4.0);
    let hazyFace = mix(face, horizon * frame.waveLightingAndHaze.z, hazeAmount);
    let glow = behindCrest * vec3f(0.22, 0.78, 0.74) * (2.2 * cover.z * (1.0 - hazeAmount));
    return mix(radiance, hazyFace, cover.x) + glow;
}
