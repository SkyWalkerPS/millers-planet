/*
 * Derived from web-ocean by Maksymilian Dendura (Noniv): https://github.com/Noniv/web-ocean
 * Copyright (c) 2026 Maksymilian Dendura. MIT License; full text in LICENSE.
 */

const ATMOSPHERE_PI: f32 = 3.14159265358979;
const TRANSMITTANCE_LUT_WIDTH: f32 = 256.0;
const TRANSMITTANCE_LUT_HEIGHT: f32 = 64.0;
const MULTIPLE_SCATTERING_LUT_SIZE: f32 = 32.0;
const SKY_VIEW_LUT_WIDTH: f32 = 256.0;
const SKY_VIEW_LUT_HEIGHT: f32 = 144.0;

struct AtmosphereParameters {
    rayleighScatteringAndScaleHeight: vec4f,
    mieScatteringExtinctionScaleHeightAsymmetry: vec4f,
    ozoneAbsorptionAndPeakHeight: vec4f,
    groundRadiusTopRadiusAlbedoMarineDensity: vec4f,
    lightDirectionAndCameraAltitude: vec4f,
    lightIlluminanceAndMarineScaleHeight: vec4f,
    deckAltitudeOpticalDepthBrightnessDirectPower: vec4f,
    deckClearingCoverageInnerOuterOvercast: vec4f,
    deckAmbientGainAndBakeOriginKilometres: vec4f,
};

struct AtmosphereMedium {
    extinction: vec3f,
    rayleighScattering: vec3f,
    mieScattering: f32,
};

fn atmosphereMedium(heightKilometres: f32, parameters: AtmosphereParameters) -> AtmosphereMedium {
    let height = max(heightKilometres, 0.0);
    let rayleighDensity = exp(-height / parameters.rayleighScatteringAndScaleHeight.w);
    let aerosolDensity = exp(-height / parameters.mieScatteringExtinctionScaleHeightAsymmetry.z)
        + parameters.groundRadiusTopRadiusAlbedoMarineDensity.w * exp(-height / parameters.lightIlluminanceAndMarineScaleHeight.w);
    let ozoneDensity = max(0.0, 1.0 - abs(height - parameters.ozoneAbsorptionAndPeakHeight.w) / 15.0);
    var medium: AtmosphereMedium;
    medium.rayleighScattering = parameters.rayleighScatteringAndScaleHeight.xyz * rayleighDensity;
    medium.mieScattering = parameters.mieScatteringExtinctionScaleHeightAsymmetry.x * aerosolDensity;
    medium.extinction = medium.rayleighScattering
        + vec3f(parameters.mieScatteringExtinctionScaleHeightAsymmetry.y * aerosolDensity)
        + parameters.ozoneAbsorptionAndPeakHeight.xyz * ozoneDensity;
    return medium;
}

fn groundRadius(parameters: AtmosphereParameters) -> f32 {
    return parameters.groundRadiusTopRadiusAlbedoMarineDensity.x;
}

fn topRadius(parameters: AtmosphereParameters) -> f32 {
    return parameters.groundRadiusTopRadiusAlbedoMarineDensity.y;
}

fn raySphereIntersection(origin: vec3f, direction: vec3f, radius: f32) -> vec2f {
    let originLength = length(origin);
    let projection = dot(origin, direction);
    let offset = (originLength - radius) * (originLength + radius);
    let discriminant = projection * projection - offset;
    if (discriminant < 0.0) {
        return vec2f(-1.0, -1.0);
    }
    let root = sqrt(discriminant);
    return vec2f(-projection - root, -projection + root);
}

fn distanceToHorizon(radius: f32, parameters: AtmosphereParameters) -> f32 {
    let ground = groundRadius(parameters);
    return sqrt(max(0.0, (radius - ground) * (radius + ground)));
}

fn transmittanceRadiusCosineToUv(radius: f32, cosine: f32, parameters: AtmosphereParameters) -> vec2f {
    let ground = groundRadius(parameters);
    let top = topRadius(parameters);
    let horizonLength = sqrt(top * top - ground * ground);
    let rho = distanceToHorizon(radius, parameters);
    let discriminant = radius * radius * (cosine * cosine - 1.0) + top * top;
    let distanceToTop = max(0.0, -radius * cosine + sqrt(max(discriminant, 0.0)));
    let minimumDistance = top - radius;
    let maximumDistance = rho + horizonLength;
    return vec2f((distanceToTop - minimumDistance) / (maximumDistance - minimumDistance), rho / horizonLength);
}

fn transmittanceUvToRadiusCosine(uv: vec2f, parameters: AtmosphereParameters) -> vec2f {
    let ground = groundRadius(parameters);
    let top = topRadius(parameters);
    let horizonLength = sqrt(top * top - ground * ground);
    let rho = horizonLength * uv.y;
    let radius = sqrt(rho * rho + ground * ground);
    let minimumDistance = top - radius;
    let maximumDistance = rho + horizonLength;
    let distanceToTop = minimumDistance + uv.x * (maximumDistance - minimumDistance);
    var cosine = 1.0;
    if (distanceToTop > 0.0) {
        cosine = (horizonLength * horizonLength - rho * rho - distanceToTop * distanceToTop) / (2.0 * radius * distanceToTop);
    }
    return vec2f(radius, clamp(cosine, -1.0, 1.0));
}

fn unitToSubUv(value: f32, resolution: f32) -> f32 {
    return (value + 0.5 / resolution) * (resolution / (resolution + 1.0));
}

fn subUvToUnit(value: f32, resolution: f32) -> f32 {
    return (value - 0.5 / resolution) * (resolution / (resolution - 1.0));
}

fn rayleighPhase(cosine: f32) -> f32 {
    return 3.0 / (16.0 * ATMOSPHERE_PI) * (1.0 + cosine * cosine);
}

fn miePhaseCornetteShanks(cosine: f32, asymmetry: f32) -> f32 {
    let asymmetrySquared = asymmetry * asymmetry;
    return 3.0 / (8.0 * ATMOSPHERE_PI) * ((1.0 - asymmetrySquared) * (1.0 + cosine * cosine))
        / ((2.0 + asymmetrySquared) * pow(max(1.0 + asymmetrySquared - 2.0 * asymmetry * cosine, 1e-4), 1.5));
}

fn henyeyGreensteinPhase(cosine: f32, asymmetry: f32) -> f32 {
    let asymmetrySquared = asymmetry * asymmetry;
    return (1.0 - asymmetrySquared) / (4.0 * ATMOSPHERE_PI * pow(max(1.0 + asymmetrySquared - 2.0 * asymmetry * cosine, 1e-4), 1.5));
}

fn lightBelowHorizon(radius: f32, cosine: f32, parameters: AtmosphereParameters) -> bool {
    return cosine < -distanceToHorizon(radius, parameters) / radius;
}

fn skyViewUvFromDirection(direction: vec3f, lightDirection: vec3f, cameraRadius: f32, parameters: AtmosphereParameters) -> vec2f {
    let horizonCosine = distanceToHorizon(cameraRadius, parameters) / cameraRadius;
    let beta = acos(clamp(horizonCosine, -1.0, 1.0));
    let zenithAngleOfHorizon = ATMOSPHERE_PI - beta;
    let viewZenithCosine = clamp(direction.y, -1.0, 1.0);
    var uv: vec2f;
    if (viewZenithCosine >= -horizonCosine) {
        var coordinate = acos(viewZenithCosine) / zenithAngleOfHorizon;
        coordinate = 1.0 - coordinate;
        coordinate = sqrt(max(coordinate, 0.0));
        coordinate = 1.0 - coordinate;
        uv.y = coordinate * 0.5;
    } else {
        var coordinate = (acos(viewZenithCosine) - zenithAngleOfHorizon) / beta;
        coordinate = sqrt(max(coordinate, 0.0));
        uv.y = coordinate * 0.5 + 0.5;
    }
    let directionLength = length(direction.xz);
    let lightLength = length(lightDirection.xz);
    var azimuthCosine = 1.0;
    if (directionLength > 1e-6 && lightLength > 1e-6) {
        azimuthCosine = clamp(dot(direction.xz, lightDirection.xz) / (directionLength * lightLength), -1.0, 1.0);
    }
    uv.x = sqrt(max(-azimuthCosine * 0.5 + 0.5, 0.0));
    return vec2f(unitToSubUv(uv.x, SKY_VIEW_LUT_WIDTH), unitToSubUv(uv.y, SKY_VIEW_LUT_HEIGHT));
}
