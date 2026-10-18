const CLOUD_DECK_ASYMMETRY: f32 = 0.85;

fn deckCoverageTowards(direction: vec3f, clearingCentre: vec3f, parameters: AtmosphereParameters) -> f32 {
    let clearing = parameters.deckClearingCoverageInnerOuterOvercast;
    let angle = acos(clamp(dot(direction, clearingCentre), -1.0, 1.0));
    return mix(clearing.x, clearing.w, smoothstep(clearing.y, clearing.z, angle));
}

fn deckDirectLightFraction(samplePoint: vec3f, cameraPoint: vec3f, lightDirection: vec3f, parameters: AtmosphereParameters) -> f32 {
    let deck = parameters.deckAltitudeOpticalDepthBrightnessDirectPower;
    let sampleHeight = length(samplePoint) - groundRadius(parameters);
    if (sampleHeight >= deck.x) {
        return 1.0;
    }
    let deckPoint = samplePoint + lightDirection * ((deck.x - sampleHeight) / max(lightDirection.y, 0.02));
    let coverage = deckCoverageTowards(normalize(deckPoint - cameraPoint), lightDirection, parameters);
    return pow(max(1.0 - coverage, 0.0), deck.w);
}

fn overcastBaseRadiancePerIlluminance(lightDirection: vec3f, parameters: AtmosphereParameters) -> vec3f {
    let deck = parameters.deckAltitudeOpticalDepthBrightnessDirectPower;
    let lightCosine = max(lightDirection.y, 0.05);
    let lightAtDeck = transmittanceTowards(groundRadius(parameters) + deck.x, lightDirection.y, parameters);
    let diffuseTransmission = 1.0 / (1.0 + 0.75 * deck.y * (1.0 - CLOUD_DECK_ASYMMETRY));
    return lightAtDeck * (lightCosine * diffuseTransmission * deck.z / ATMOSPHERE_PI);
}

fn underDeckAmbientSource(sampleHeight: f32, medium: AtmosphereMedium, baseRadiance: vec3f, parameters: AtmosphereParameters) -> vec3f {
    if (sampleHeight >= parameters.deckAltitudeOpticalDepthBrightnessDirectPower.x) {
        return vec3f(0.0);
    }
    let weight = 0.5 * parameters.deckClearingCoverageInnerOuterOvercast.w * parameters.deckAmbientGainAndBakeOriginKilometres.x;
    return (medium.rayleighScattering + vec3f(medium.mieScattering)) * baseRadiance * weight;
}
