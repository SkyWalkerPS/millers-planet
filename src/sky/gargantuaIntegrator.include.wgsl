const PI: f32 = 3.14159265358979;
const TAU: f32 = 6.28318530717959;
const BLACKBODY_TABLE_SIZE: i32 = 512;
const BLACKBODY_LOG2_MIN: f32 = 7.96578428;
const BLACKBODY_LOG2_MAX: f32 = 18.60964047;

fn hash32(value: u32) -> u32 {
  let state = value * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

fn luminance(color: vec3f) -> f32 {
  return dot(color, vec3f(0.2126, 0.7152, 0.0722));
}

fn blackbodyEntry(index: i32) -> vec4f {
  return textureLoad(blackbodyTable, vec2i(clamp(index, 0, BLACKBODY_TABLE_SIZE - 1), 0), 0);
}

fn blackbodyLookup(temperature: f32) -> vec4f {
  let position = (log2(max(temperature, 1.0)) - BLACKBODY_LOG2_MIN) / (BLACKBODY_LOG2_MAX - BLACKBODY_LOG2_MIN) * f32(BLACKBODY_TABLE_SIZE - 1);
  let index = i32(floor(position));
  return mix(blackbodyEntry(index), blackbodyEntry(index + 1), clamp(position - floor(position), 0.0, 1.0));
}

fn blackbodyRadiance(temperature: f32) -> vec3f {
  let entry = blackbodyLookup(temperature);
  return entry.rgb * exp2(entry.a);
}

fn blackbodyChromaticity(temperature: f32) -> vec3f {
  return blackbodyLookup(temperature).rgb;
}

const OUTCOME_CAPTURED: u32 = 0u;
const OUTCOME_ESCAPED: u32 = 1u;
const OUTCOME_STEP_LIMIT: u32 = 2u;
const OUTCOME_OPAQUE: u32 = 3u;
const NEAR_W: f32 = 0.12;
const FAR_W: f32 = 0.03;
const HORIZON_GAP_FRACTION: f32 = 0.5;
const SUPERSAMPLE_STEP_THRESHOLD: u32 = 45u;
const DISK_DENSITY_FLOOR: f32 = 0.35;
const DISK_SCALE_HEIGHT: f32 = 0.02;
const DISK_MIN_PATH_COSINE: f32 = 0.15;
const TURBULENCE_LIFETIME_ORBITS: f32 = 0.6;
const TURBULENCE_ZONES_PER_OCTAVE: f32 = 2.0;
const TURBULENCE_SPIRAL_PITCH: f32 = 1.6;
const TURBULENCE_RADIAL_SCALE: f32 = 1.0;
const TURBULENCE_TEXTURE_WIDTH: f32 = 1024.0;
const TURBULENCE_TEXTURE_HEIGHT: f32 = 256.0;
const FRAME_DRAG_STEP_ANGLE: f32 = 0.25;

struct RayConstants {
  energy: f32,
  angularMomentum: f32,
  radialC0: f32,
  radialC1: f32,
  radialC2: f32,
  sphereSpeedSquared: f32,
  spinEnergySquared: f32,
  spinShift: f32,
}

struct RayState {
  w: f32,
  dw: f32,
  sphere: vec3f,
  sphereVelocity: vec3f,
  frameDragAngle: f32,
  coordinateTime: f32,
  regularTimeIncrement: f32,
}

struct RayRates {
  ddw: f32,
  sphereAcceleration: vec3f,
  frameDragRate: f32,
  regularTimeRate: f32,
}

struct TraceResult {
  outcome: u32,
  steps: u32,
  crossings: u32,
  skyDirection: vec3f,
  skyRedshift: f32,
  emission: vec3f,
  transmittance: f32,
  firstCrossing: vec4f,
}

fn makeRayConstants(local: vec3f) -> RayConstants {
  let a = frame.spin;
  let energy = -frame.cameraLapse + frame.cameraFrameDragVelocity * local.z;
  let angularMomentum = frame.cameraCylindricalRadius * local.z;
  let thetaRate = frame.cameraSqrtSigma * local.y;
  let carterQ = thetaRate * thetaRate + frame.cameraCosThetaSquared * (frame.cameraAOverSigma * local.z * local.z - a * a * energy * energy);
  let shiftedMomentum = angularMomentum - a * energy;
  let kerrK = carterQ + shiftedMomentum * shiftedMomentum;
  let spinShift = -a * shiftedMomentum;
  var constants: RayConstants;
  constants.energy = energy;
  constants.angularMomentum = angularMomentum;
  constants.radialC0 = 2.0 * energy * spinShift - kerrK;
  constants.radialC1 = 3.0 * kerrK;
  constants.radialC2 = 2.0 * (spinShift * spinShift - a * a * kerrK);
  constants.sphereSpeedSquared = carterQ + angularMomentum * angularMomentum;
  constants.spinEnergySquared = a * a * energy * energy;
  constants.spinShift = spinShift;
  return constants;
}

fn makeInitialState(local: vec3f) -> RayState {
  var state: RayState;
  state.w = frame.cameraInverseRadius;
  state.dw = -frame.cameraRadialRateScale * local.x;
  state.sphere = frame.cameraSphereUnit;
  state.sphereVelocity = (frame.cameraSqrtSigma * local.y) * frame.cameraSphereThetaHat + (frame.cameraAzimuthalScale * local.z) * frame.cameraPhiHat;
  state.frameDragAngle = 0.0;
  state.coordinateTime = 0.0;
  state.regularTimeIncrement = 0.0;
  return state;
}

fn rayRates(constants: RayConstants, w: f32, sphere: vec3f) -> RayRates {
  let a = frame.spin;
  let u = sphere.z;
  var rates: RayRates;
  rates.ddw = w * (constants.radialC0 + w * (constants.radialC1 + w * constants.radialC2));
  let pull = -constants.sphereSpeedSquared - 2.0 * constants.spinEnergySquared * u * u;
  rates.sphereAcceleration = pull * sphere + vec3f(0.0, 0.0, constants.spinEnergySquared * u);
  let inverseDelta = 1.0 / max(1.0 - 2.0 * w + a * a * w * w, 1e-5);
  rates.frameDragRate = a * w * (2.0 * constants.energy - a * constants.angularMomentum * w) * inverseDelta;
  rates.regularTimeRate = (2.0 * constants.energy * (2.0 - a * a * w) + constants.spinShift * (1.0 + a * a * w * w)) * inverseDelta
    + a * (constants.angularMomentum - a * constants.energy * (1.0 - u * u));
  return rates;
}

fn singularTimeIntegral(energy: f32, h: f32, w0: f32, w1: f32) -> f32 {
  let safeW1 = max(w1, 1e-6);
  let relativeChange = (safeW1 - w0) / w0;
  var logRatioOverDifference = log(safeW1 / w0) / (safeW1 - w0);
  if (abs(relativeChange) < 1e-2) {
    logRatioOverDifference = (1.0 - relativeChange * 0.5 + relativeChange * relativeChange * (1.0 / 3.0)) / w0;
  }
  return energy * h * (1.0 / (w0 * safeW1) + 2.0 * logRatioOverDifference);
}

fn advanceRay(constants: RayConstants, state: RayState, h: f32) -> RayState {
  let first = rayRates(constants, state.w, state.sphere);
  let halfStep = 0.5 * h;
  let stepSquaredOver8 = 0.125 * h * h;
  let second = rayRates(constants,
    state.w + halfStep * state.dw + stepSquaredOver8 * first.ddw,
    state.sphere + halfStep * state.sphereVelocity + stepSquaredOver8 * first.sphereAcceleration);
  let stepSquaredOver2 = 0.5 * h * h;
  let third = rayRates(constants,
    state.w + h * state.dw + stepSquaredOver2 * second.ddw,
    state.sphere + h * state.sphereVelocity + stepSquaredOver2 * second.sphereAcceleration);
  let stepSquaredOver6 = h * h * (1.0 / 6.0);
  let stepOver6 = h * (1.0 / 6.0);
  var next: RayState;
  next.w = state.w + h * state.dw + stepSquaredOver6 * (first.ddw + 2.0 * second.ddw);
  next.dw = state.dw + stepOver6 * (first.ddw + 4.0 * second.ddw + third.ddw);
  let sphere = state.sphere + h * state.sphereVelocity + stepSquaredOver6 * (first.sphereAcceleration + 2.0 * second.sphereAcceleration);
  let sphereVelocity = state.sphereVelocity + stepOver6 * (first.sphereAcceleration + 4.0 * second.sphereAcceleration + third.sphereAcceleration);
  next.sphere = normalize(sphere);
  next.sphereVelocity = sphereVelocity - dot(sphereVelocity, next.sphere) * next.sphere;
  next.frameDragAngle = state.frameDragAngle + stepOver6 * (first.frameDragRate + 4.0 * second.frameDragRate + third.frameDragRate);
  next.regularTimeIncrement = stepOver6 * (first.regularTimeRate + 4.0 * second.regularTimeRate + third.regularTimeRate);
  next.coordinateTime = state.coordinateTime + next.regularTimeIncrement + singularTimeIntegral(constants.energy, h, state.w, next.w);
  return next;
}

fn stepSize(constants: RayConstants, state: RayState, angleScale: f32) -> f32 {
  let a = frame.spin;
  let u = state.sphere.z;
  let sphereSpeed = sqrt(max(constants.sphereSpeedSquared + constants.spinEnergySquared * u * u, 0.0));
  let nearness = clamp((state.w - FAR_W) / (NEAR_W - FAR_W), 0.0, 1.0);
  let angle = mix(frame.stepAngleFar, frame.stepAngleNear, nearness) * angleScale;
  let horizonApproach = max(state.dw, 0.0) / (HORIZON_GAP_FRACTION * max(frame.horizonW - state.w, 1e-4));
  let delta = 1.0 - 2.0 * state.w + a * a * state.w * state.w;
  let frameDragRate = abs(a * state.w * (2.0 * constants.energy - a * constants.angularMomentum * state.w)) / max(delta, 1e-4);
  let diskZoneDrag = select(0.0, frameDragRate / FRAME_DRAG_STEP_ANGLE, state.w < frame.diskZoneW);
  let rate = max(max(sphereSpeed, abs(state.dw) * angle / frame.stepRadialSpan), max(max(horizonApproach, diskZoneDrag), 1e-6) * angle);
  return angle / max(rate, 1e-6);
}

fn hermiteInterpolate(p0: f32, d0: f32, p1: f32, d1: f32, h: f32, f: f32) -> f32 {
  let f2 = f * f;
  let f3 = f2 * f;
  return (2.0 * f3 - 3.0 * f2 + 1.0) * p0 + (f3 - 2.0 * f2 + f) * h * d0 + (3.0 * f2 - 2.0 * f3) * p1 + (f3 - f2) * h * d1;
}

fn rotateAboutSpinAxis(v: vec3f, angle: f32) -> vec3f {
  let c = cos(angle);
  let s = sin(angle);
  return vec3f(v.x * c - v.y * s, v.x * s + v.y * c, v.z);
}

fn diskFlux(radius: f32) -> f32 {
  let x = sqrt(radius);
  let bracket = x - frame.fluxX0 - 1.5 * frame.spin * (log(x) - frame.fluxLogX0)
    - frame.fluxWeight1 * (log(x - frame.fluxX1) - frame.fluxLogOffset1)
    - frame.fluxWeight2 * (log(x - frame.fluxX2) - frame.fluxLogOffset2)
    - frame.fluxWeight3 * (log(x - frame.fluxX3) - frame.fluxLogOffset3);
  let x2 = x * x;
  return max(bracket, 0.0) / (x2 * x2 * (x2 * x - 3.0 * x + 2.0 * frame.spin));
}

fn diskOpacityProfile(radius: f32) -> f32 {
  let inner = frame.diskInnerRadius;
  let innerTaper = smoothstep(inner, inner * 1.3, radius);
  let outerTaper = 1.0 - smoothstep(frame.diskOuterRadius * 0.45, frame.diskOuterRadius, radius);
  return innerTaper * outerTaper * pow(inner * 2.5 / max(radius, inner * 2.5), 0.9);
}

fn generationOffset(generation: f32, layer: i32) -> vec2f {
  let seed = hash32(bitcast<u32>(i32(generation)) * 0x9e3779b1u + u32(layer) * 0x7f4a7c15u);
  return vec2f(f32(seed & 0xffffu), f32(seed >> 16u)) * (1.0 / 65536.0);
}

fn diskTurbulence(radius: f32, azimuth: f32, time: f32, detailLevel: f32) -> vec2f {
  let logRadius = log(radius);
  let orbitalRate = 1.0 / (radius * sqrt(radius) + frame.spin);
  let zoneCoordinate = log2(radius / frame.diskInnerRadius) * TURBULENCE_ZONES_PER_OCTAVE;
  let zoneBase = floor(zoneCoordinate);
  let zoneBlend = zoneCoordinate - zoneBase;
  var blended = vec4f(0.0);
  var weightSquares = 0.0;
  for (var zone = 0; zone < 2; zone++) {
    let zoneIndex = zoneBase + f32(zone);
    let zoneWeight = select(1.0 - zoneBlend, zoneBlend, zone == 1);
    let zoneRadius = frame.diskInnerRadius * exp2(zoneIndex / TURBULENCE_ZONES_PER_OCTAVE);
    let naturalLifetime = TAU * TURBULENCE_LIFETIME_ORBITS * (zoneRadius * sqrt(zoneRadius) + frame.spin);
    let looping = frame.turbulenceLoopPeriod > 0.0;
    let cyclesPerLoop = max(round(frame.turbulenceLoopPeriod / naturalLifetime), 1.0);
    let lifetime = select(naturalLifetime, frame.turbulenceLoopPeriod / cyclesPerLoop, looping);
    let zonePhase = time / lifetime + zoneIndex * 0.381966;
    for (var layer = 0; layer < 2; layer++) {
      let layerPhase = zonePhase + 0.5 * f32(layer);
      let age = fract(layerPhase);
      let weight = zoneWeight * (1.0 - abs(2.0 * age - 1.0));
      let advectedAzimuth = azimuth - orbitalRate * age * lifetime + TURBULENCE_SPIRAL_PITCH * logRadius;
      let generation = select(floor(layerPhase), floor(layerPhase) - cyclesPerLoop * floor(floor(layerPhase) / cyclesPerLoop), looping);
      let coordinates = vec2f(advectedAzimuth * (1.0 / TAU), logRadius * TURBULENCE_RADIAL_SCALE) + generationOffset(generation, layer + 2 * i32(zoneIndex));
      blended += weight * textureSampleLevel(diskNoiseTexture, repeatSampler, coordinates, detailLevel);
      weightSquares += weight * weight;
    }
  }
  let fields = blended * inverseSqrt(max(weightSquares, 0.1));
  let structure = 2.2 * fields.x + 0.12 * fields.y + 0.45 * fields.z + 1.2 * fields.w;
  return vec2f(exp(structure), 0.9 * fields.x + 0.35 * fields.z + 0.5 * fields.w);
}

fn shadeDiskCrossing(constants: RayConstants, radius: f32, azimuth: f32, emissionTime: f32, normalRate: f32, crossingW: f32) -> vec4f {
  let a = frame.spin;
  let sqrtRadius = sqrt(radius);
  let radiusToThreeHalves = radius * sqrtRadius;
  let orbitalRate = 1.0 / (radiusToThreeHalves + a);
  let timeDilation = (radiusToThreeHalves + a) / (sqrt(sqrtRadius) * sqrtRadius * sqrt(max(radiusToThreeHalves - 3.0 * sqrtRadius + 2.0 * a, 1e-6)));
  let redshift = 1.0 / max(timeDilation * (orbitalRate * constants.angularMomentum - constants.energy), 1e-4);
  let emittedTemperature = frame.diskPeakTemperature * pow(max(diskFlux(radius) * frame.inverseMaxFlux, 0.0), 0.25);
  let emissionCosine = clamp(normalRate * crossingW * redshift, 0.04, 1.0);
  let slabCosine = max(emissionCosine, DISK_MIN_PATH_COSINE);
  let pixelFootprint = frame.tanHalfFovY * 2.0 / frame.internalSize.y * max(abs(emissionTime), 1.0) * inverseSqrt(slabCosine);
  let slabSmear = 2.0 * DISK_SCALE_HEIGHT * radius * sqrt(max(1.0 - slabCosine * slabCosine, 0.0)) / slabCosine;
  let footprint = max(pixelFootprint, slabSmear);
  let texelsPerUnitLength = max(TURBULENCE_TEXTURE_WIDTH / (TAU * radius), TURBULENCE_TEXTURE_HEIGHT * TURBULENCE_RADIAL_SCALE / radius);
  let detailLevel = max(log2(footprint * texelsPerUnitLength), 0.0);
  let turbulence = diskTurbulence(radius, azimuth, frame.diskTime + emissionTime, detailLevel);
  let localTemperature = emittedTemperature * clamp(1.0 + 0.12 * turbulence.y, 0.75, 1.3);
  let opticalDepth = frame.diskOpacity * diskOpacityProfile(radius) * (DISK_DENSITY_FLOOR + turbulence.x);
  let transmission = exp(-opticalDepth / slabCosine);
  let limbDarkening = mix(1.0, (1.0 + 2.06 * emissionCosine) / 2.3733, 1.0 - exp(-opticalDepth));
  var radiance: vec3f;
  if (frame.cinematicColor > 0.5) {
    let warmTemperature = emittedTemperature * 0.62 * mix(1.0, redshift, 0.15);
    let brightness = luminance(blackbodyRadiance(localTemperature)) * pow(redshift, 1.4);
    radiance = blackbodyChromaticity(warmTemperature) * brightness * 1.15;
  } else {
    radiance = blackbodyRadiance(localTemperature * redshift);
  }
  return vec4f(radiance * ((1.0 - transmission) * limbDarkening), transmission);
}

fn traceRay(local: vec3f, shadeDisk: bool, angleScale: f32) -> TraceResult {
  let constants = makeRayConstants(local);
  var state = makeInitialState(local);
  var result: TraceResult;
  result.outcome = OUTCOME_STEP_LIMIT;
  result.steps = 0u;
  result.crossings = 0u;
  result.skyDirection = vec3f(0.0);
  result.skyRedshift = 1.0 / max(-constants.energy, 1e-3);
  result.emission = vec3f(0.0);
  result.transmittance = 1.0;
  result.firstCrossing = vec4f(0.0);
  let stepLimit = u32(frame.maxSteps);
  for (var stepIndex = 0u; stepIndex < stepLimit; stepIndex++) {
    let h = stepSize(constants, state, angleScale);
    let next = advanceRay(constants, state, h);
    result.steps = stepIndex + 1u;
    if ((state.sphere.z > 0.0) != (next.sphere.z > 0.0)) {
      let fraction = state.sphere.z / (state.sphere.z - next.sphere.z);
      let crossingW = hermiteInterpolate(state.w, state.dw, next.w, next.dw, h, fraction);
      let radius = 1.0 / crossingW;
      if (radius > frame.diskInnerRadius && radius < frame.diskOuterRadius) {
        let planar = mix(state.sphere.xy, next.sphere.xy, fraction);
        let azimuth = atan2(planar.y, planar.x) + mix(state.frameDragAngle, next.frameDragAngle, fraction);
        let emissionTime = state.coordinateTime + fraction * next.regularTimeIncrement + singularTimeIntegral(constants.energy, fraction * h, state.w, crossingW);
        let normalRate = abs(mix(state.sphereVelocity.z, next.sphereVelocity.z, fraction));
        if (result.crossings == 0u) {
          result.firstCrossing = vec4f(radius, azimuth, emissionTime, normalRate * crossingW);
        }
        result.crossings += 1u;
        if (shadeDisk) {
          let crossingSample = shadeDiskCrossing(constants, radius, azimuth, emissionTime, normalRate, crossingW);
          result.emission += result.transmittance * crossingSample.rgb;
          result.transmittance *= crossingSample.a;
          if (result.transmittance < 0.004) {
            result.outcome = OUTCOME_OPAQUE;
            break;
          }
        }
      }
    }
    if (frame.earlyEscape > 0.5 && next.dw < 0.0 && next.w < frame.diskOuterW) {
      result.skyDirection = rotateAboutSpinAxis(next.sphere, next.frameDragAngle);
      result.outcome = OUTCOME_ESCAPED;
      break;
    }
    if (next.w <= 0.0) {
      let fraction = state.w / (state.w - next.w);
      let sphere = normalize(mix(state.sphere, next.sphere, fraction));
      result.skyDirection = rotateAboutSpinAxis(sphere, mix(state.frameDragAngle, next.frameDragAngle, fraction));
      result.outcome = OUTCOME_ESCAPED;
      break;
    }
    if (next.w >= frame.horizonStopW) {
      result.outcome = OUTCOME_CAPTURED;
      break;
    }
    state = next;
  }
  if (result.outcome == OUTCOME_STEP_LIMIT && state.dw < 0.0 && state.w < 0.06) {
    result.skyDirection = rotateAboutSpinAxis(state.sphere, state.frameDragAngle);
    result.outcome = OUTCOME_ESCAPED;
  }
  return result;
}

fn heatColor(value: f32) -> vec3f {
  let t = clamp(value, 0.0, 1.0);
  return clamp(vec3f(1.5 * t, 2.0 * t - 0.5, 4.0 * t * (1.0 - t)) + vec3f(0.0, 0.0, 0.15), vec3f(0.0), vec3f(1.0)) * 4.0;
}

fn localRayDirection(pixel: vec2f) -> vec3f {
  let ndc = vec2f(pixel.x / frame.internalSize.x * 2.0 - 1.0, 1.0 - pixel.y / frame.internalSize.y * 2.0);
  let directionBh = normalize(frame.cameraForward
    + (ndc.x * frame.aspectRatio * frame.tanHalfFovY) * frame.cameraRight
    + (ndc.y * frame.tanHalfFovY) * frame.cameraUp);
  return vec3f(dot(directionBh, frame.cameraRadialHat), dot(directionBh, frame.cameraPolarHat), dot(directionBh, frame.cameraPhiHat));
}

fn supersampleOffset(index: u32) -> vec2f {
  let corner = vec2f(select(-0.375, 0.125, (index & 1u) != 0u), select(-0.125, 0.375, (index & 2u) != 0u));
  return select(corner, vec2f(-corner.y, corner.x), (index & 1u) != (index >> 1u));
}
