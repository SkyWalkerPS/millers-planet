struct SuitLightEnvironment {
    origin: vec3f,
    lightDirection: vec3f,
    directIrradiance: vec3f,
    skyIrradiance: vec3f,
};

fn suitLightEnvironment(world: vec3f) -> SuitLightEnvironment {
    let lightDirection = atmosphere.lightDirectionAndCameraAltitude.xyz;
    let illuminance = atmosphere.lightIlluminanceAndMarineScaleHeight.xyz;
    let planetRadius = groundRadius(atmosphere);
    let surfacePoint = vec3f(0.0, planetRadius + 0.0005, 0.0);
    let cameraPoint = vec3f(0.0, planetRadius + atmosphere.lightDirectionAndCameraAltitude.w, 0.0);
    let offsetKilometres = vec3f(world.x - frame.cameraPositionAndTime.x, 0.0, world.z - frame.cameraPositionAndTime.z) * 0.001;
    let directFraction = deckDirectLightFraction(surfacePoint + offsetKilometres, cameraPoint, lightDirection, atmosphere);
    var environment: SuitLightEnvironment;
    environment.origin = world;
    environment.lightDirection = lightDirection;
    environment.directIrradiance = illuminance * transmittanceToSpace(lightDirection) * directFraction * frame.waveLightingAndHaze.x;
    environment.skyIrradiance = overcastBaseRadiancePerIlluminance(lightDirection, atmosphere) * illuminance * (ATMOSPHERE_PI * atmosphere.deckClearingCoverageInnerOuterOvercast.w * atmosphere.deckAmbientGainAndBakeOriginKilometres.x) * frame.waveLightingAndHaze.y;
    return environment;
}

fn waterFresnel(cosine: f32) -> f32 {
    let complement = 1.0 - clamp(cosine, 0.0, 1.0);
    let squared = complement * complement;
    return 0.02 + 0.98 * squared * squared * complement;
}

fn seaReflectionRadiance(direction: vec3f, environment: SuitLightEnvironment, gargantuaLevel: f32, cloudLevel: f32, seaBodyFraction: f32) -> vec3f {
    let mirrored = normalize(vec3f(direction.x, max(abs(direction.y), 0.01), direction.z));
    let fresnel = waterFresnel(abs(direction.y));
    let body = environment.skyIrradiance * (seaBodyFraction / ATMOSPHERE_PI);
    let mirroredSky = applyWaveToReflection(skyRadianceBlurred(mirrored, max(gargantuaLevel, 6.5), max(cloudLevel, 5.5)), environment.origin, mirrored, environment.skyIrradiance, max(gargantuaLevel, 6.5));
    return mirroredSky * fresnel + body * (1.0 - fresnel);
}

fn environmentRadiance(direction: vec3f, environment: SuitLightEnvironment, gargantuaLevel: f32, cloudLevel: f32, seaBodyFraction: f32) -> vec3f {
    let underwater = frame.underwaterMediumAndDensity;
    if (underwater.w > 0.0) {
        return underwater.rgb * (0.5 + 1.5 * max(direction.y, 0.0));
    }
    if (direction.y >= 0.0) {
        return applyWaveToReflection(skyRadianceBlurred(direction, gargantuaLevel, cloudLevel), environment.origin, direction, environment.skyIrradiance, gargantuaLevel);
    }
    return seaReflectionRadiance(direction, environment, gargantuaLevel, cloudLevel, seaBodyFraction);
}

fn ggxDistribution(normalDotHalf: f32, alpha: f32) -> f32 {
    let alphaSquared = alpha * alpha;
    let denominator = normalDotHalf * normalDotHalf * (alphaSquared - 1.0) + 1.0;
    return alphaSquared / (ATMOSPHERE_PI * denominator * denominator);
}

fn smithCorrelatedVisibility(normalDotView: f32, normalDotLight: f32, alpha: f32) -> f32 {
    let alphaSquared = alpha * alpha;
    let viewTerm = normalDotLight * sqrt(normalDotView * normalDotView * (1.0 - alphaSquared) + alphaSquared);
    let lightTerm = normalDotView * sqrt(normalDotLight * normalDotLight * (1.0 - alphaSquared) + alphaSquared);
    return 0.5 / max(viewTerm + lightTerm, 1e-5);
}

fn schlickFresnel(baseReflectance: vec3f, cosine: f32) -> vec3f {
    let complement = 1.0 - clamp(cosine, 0.0, 1.0);
    let squared = complement * complement;
    return baseReflectance + (vec3f(1.0) - baseReflectance) * (squared * squared * complement);
}

fn environmentBrdfApproximation(specularColour: vec3f, roughness: f32, normalDotView: f32) -> vec3f {
    let c0 = vec4f(-1.0, -0.0275, -0.572, 0.022);
    let c1 = vec4f(1.0, 0.0425, 1.04, -0.04);
    let r = roughness * c0 + c1;
    let a004 = min(r.x * r.x, exp2(-9.28 * normalDotView)) * r.x + r.y;
    let scaleAndBias = vec2f(-1.04, 1.04) * a004 + r.zw;
    return specularColour * scaleAndBias.x + vec3f(scaleAndBias.y);
}

fn reflectionMipLevels(roughness: f32) -> vec2f {
    let spreadRadians = max(roughness * roughness * 1.6, 0.004);
    return vec2f(log2(max(spreadRadians / 0.00075, 1.0)), log2(max(spreadRadians / 0.00153, 1.0)));
}
