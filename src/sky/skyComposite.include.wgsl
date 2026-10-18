fn skyCameraRadius() -> f32 {
    return groundRadius(atmosphere) + max(atmosphere.lightDirectionAndCameraAltitude.w, 0.001);
}

fn atmosphereInscatterRadiance(direction: vec3f) -> vec3f {
    let uv = skyViewUvFromDirection(direction, atmosphere.lightDirectionAndCameraAltitude.xyz, skyCameraRadius(), atmosphere);
    return textureSampleLevel(skyViewLut, skyViewLutSampler, uv, 0.0).rgb * atmosphere.lightIlluminanceAndMarineScaleHeight.xyz;
}

fn transmittanceToSpace(direction: vec3f) -> vec3f {
    let uv = transmittanceRadiusCosineToUv(skyCameraRadius(), direction.y, atmosphere);
    return textureSampleLevel(transmittanceLut, transmittanceLutSampler, uv, 0.0).rgb;
}

fn transmittanceTowards(radius: f32, cosine: f32, parameters: AtmosphereParameters) -> vec3f {
    return textureSampleLevel(transmittanceLut, transmittanceLutSampler, transmittanceRadiusCosineToUv(radius, cosine, parameters), 0.0).rgb;
}

fn cloudDeckBakeDirection(direction: vec3f) -> vec3f {
    let bakeOrigin = atmosphere.deckAmbientGainAndBakeOriginKilometres.yzw;
    let cameraKilometres = frame.cameraPositionAndTime.xyz * 0.001;
    let deckAltitude = atmosphere.deckAltitudeOpticalDepthBrightnessDirectPower.x;
    let riseToDeck = deckAltitude - cameraKilometres.y;
    let distanceToDeck = riseToDeck / max(direction.y, 1e-3);
    let horizontalHit = cameraKilometres.xz - bakeOrigin.xz + direction.xz * distanceToDeck;
    return normalize(vec3f(horizontalHit.x, deckAltitude - bakeOrigin.y, horizontalHit.y));
}

fn sampleCloudDeckAtLevel(direction: vec3f, level: f32) -> vec4f {
    return textureSampleLevel(cloudDeckTexture, cloudDeckTextureSampler, cloudDeckUvFromDirection(cloudDeckBakeDirection(direction)), level);
}

fn sampleCloudDeck(direction: vec3f) -> vec4f {
    return sampleCloudDeckAtLevel(direction, 0.0);
}

fn skyRadianceBlurred(direction: vec3f, gargantuaLevel: f32, cloudLevel: f32) -> vec3f {
    let skyDirection = normalize(vec3f(direction.x, max(direction.y, 0.0005), direction.z));
    let gargantua = sampleGargantua(skyDirection, gargantuaLevel);
    let shadowFactor = mix(1.0, frame.gargantuaRadianceScaleAndShadowStrength.y, 1.0 - gargantua.a);
    let clear = atmosphereInscatterRadiance(skyDirection) * shadowFactor + gargantua.rgb * transmittanceToSpace(skyDirection);
    let cloud = sampleCloudDeckAtLevel(skyDirection, cloudLevel);
    return clear * (1.0 - cloud.a) + cloud.rgb;
}

fn skyRadianceAboveHorizon(direction: vec3f) -> vec3f {
    return skyRadianceBlurred(direction, 0.0, 0.0);
}
