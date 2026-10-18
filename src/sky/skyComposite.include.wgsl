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

fn cloudDeckBakeDirection(direction: vec3f) -> vec3f {
    let bakeOrigin = atmosphere.deckAmbientGainAndBakeOriginKilometres.yzw;
    let cameraKilometres = frame.cameraPositionAndTime.xyz * 0.001;
    let deckAltitude = atmosphere.deckAltitudeOpticalDepthBrightnessDirectPower.x;
    let riseToDeck = deckAltitude - cameraKilometres.y;
    let distanceToDeck = riseToDeck / max(direction.y, 1e-3);
    let horizontalHit = cameraKilometres.xz - bakeOrigin.xz + direction.xz * distanceToDeck;
    return normalize(vec3f(horizontalHit.x, deckAltitude - bakeOrigin.y, horizontalHit.y));
}

fn sampleCloudDeck(direction: vec3f) -> vec4f {
    return textureSampleLevel(cloudDeckTexture, cloudDeckTextureSampler, cloudDeckUvFromDirection(cloudDeckBakeDirection(direction)), 0.0);
}

fn skyRadianceAboveHorizon(direction: vec3f) -> vec3f {
    let skyDirection = normalize(vec3f(direction.x, max(direction.y, 0.0005), direction.z));
    let gargantua = sampleGargantua(skyDirection, 0.0);
    let shadowFactor = mix(1.0, frame.gargantuaRadianceScaleAndShadowStrength.y, 1.0 - gargantua.a);
    let clear = atmosphereInscatterRadiance(skyDirection) * shadowFactor + gargantua.rgb * transmittanceToSpace(skyDirection);
    let cloud = sampleCloudDeck(skyDirection);
    return clear * (1.0 - cloud.a) + cloud.rgb;
}
