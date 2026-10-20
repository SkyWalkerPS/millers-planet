import { WAVE_PHASE_BRACE, WAVE_PHASE_DRAIN, WAVE_PHASE_RIDE } from "../wave/waveTimeline.js";
import { waveRideSettings } from "../wave/waveRide.js";

const degrees = Math.PI / 180;

export const waveCameraSettings = {
    blendInSeconds: 1.2,
    behindDistanceMetres: 3.2,
    behindSideMetres: 0.55,
    behindHeightAboveWaterMetres: 0.6,
    lookUpMinimumRadians: 12 * degrees,
    lookUpMaximumRadians: 24 * degrees,
    lookUpOfCrest: 0.45,
    orbitStartSeconds: 2.5,
    orbitEndSeconds: 4.5,
    frontAngleRadians: 0.48,
    frontDistanceMetres: 1.6,
    frontHeightAboveHelmetMetres: 0.05,
    returnStartSeconds: 5.7,
    returnEndSeconds: 7.6,
    climbBearingRadians: 0.6,
    climbDistanceMetres: 9,
    climbHeightMetres: -3,
    crestBearingRadians: 0.3,
    crestDistanceMetres: 14,
    crestHeightMetres: -3,
    descentBearingRadians: 2.54,
    descentDistanceMetres: 9,
    descentHeightMetres: -3,
    landedDistanceMetres: 6,
    landedHeightAboveWaterMetres: 1.2,
    toCrestFromCrossingSeconds: [-1.4, -0.3],
    toDescentFromCrossingSeconds: [-0.2, 0.9],
    overCrestLiftMetres: 30,
    landingFromSplashdownSeconds: [-0.2, 1.2],
    rideClearOfWaterMetres: 1.5,
    lookAboveBodyMetres: 0.3,
    drainBlendStartSeconds: 0.5,
    drainBlendEndSeconds: 5.5,
    braceInSeconds: 0.9,
};

function smoothstep(low, high, value) {
    const x = Math.min(1, Math.max(0, (value - low) / (high - low)));
    return x * x * (3 - 2 * x);
}

export function waveCameraWeight(state, settings = waveCameraSettings) {
    if (state.phase === WAVE_PHASE_BRACE) {
        return smoothstep(0, settings.blendInSeconds, state.secondsIntoPhase);
    }
    if (state.phase === WAVE_PHASE_RIDE) {
        return 1;
    }
    if (state.phase === WAVE_PHASE_DRAIN) {
        return 1 - smoothstep(settings.drainBlendStartSeconds, settings.drainBlendEndSeconds, state.secondsIntoPhase);
    }
    return 0;
}

export function braceAmountFor(state, settings = waveCameraSettings) {
    if (state.phase === WAVE_PHASE_BRACE) {
        return Math.min(1, state.secondsIntoPhase / settings.braceInSeconds);
    }
    if (state.phase === WAVE_PHASE_RIDE) {
        return 1;
    }
    if (state.phase === WAVE_PHASE_DRAIN) {
        const seconds = state.secondsIntoPhase;
        if (seconds < 1) {
            return 1;
        }
        if (seconds < 3) {
            return 1 - 0.55 * smoothstep(1, 3, seconds);
        }
        if (seconds < 3.6) {
            return 0.45;
        }
        return 0.45 * (1 - smoothstep(3.6, 5.5, seconds));
    }
    return 0;
}

export function inputLockedFor(state) {
    return state.phase === WAVE_PHASE_BRACE || state.phase === WAVE_PHASE_RIDE || state.phase === WAVE_PHASE_DRAIN;
}

function lookAngles(directionX, directionY, directionZ, out) {
    out[0] = Math.atan2(directionX, directionZ);
    out[1] = Math.atan2(directionY, Math.hypot(directionX, directionZ));
    return out;
}

function lookAt(out, targetX, targetY, targetZ) {
    const angles = lookAngles(targetX - out.position[0], targetY - out.position[1], targetZ - out.position[2], out.scratchAngles);
    out.yawRadians = angles[0];
    out.pitchRadians = angles[1];
    return out;
}

function blendThroughKeys(first, second, third, toSecond, toThird) {
    return first + (second - first) * toSecond + (third - second) * toThird;
}

export function rideCameraPose(secondsSinceImpact, ride, out, settings = waveCameraSettings, rideSettings = waveRideSettings) {
    const s = secondsSinceImpact;
    const [bodyX, bodyY, bodyZ] = ride.body;
    const [travelX, travelZ] = ride.travel;
    const crossing = rideSettings.crestCrossingSeconds;
    const splashdown = rideSettings.splashdownSeconds;
    const toCrest = smoothstep(crossing + settings.toCrestFromCrossingSeconds[0], crossing + settings.toCrestFromCrossingSeconds[1], s);
    const toDescent = smoothstep(crossing + settings.toDescentFromCrossingSeconds[0], crossing + settings.toDescentFromCrossingSeconds[1], s);
    const landing = smoothstep(splashdown + settings.landingFromSplashdownSeconds[0], splashdown + settings.landingFromSplashdownSeconds[1], s);
    const bearing = blendThroughKeys(settings.climbBearingRadians, settings.crestBearingRadians, settings.descentBearingRadians, toCrest, toDescent);
    let distance = blendThroughKeys(settings.climbDistanceMetres, settings.crestDistanceMetres, settings.descentDistanceMetres, toCrest, toDescent);
    const overCrest = Math.sin(Math.PI * toDescent);
    const height = blendThroughKeys(settings.climbHeightMetres, settings.crestHeightMetres, settings.descentHeightMetres, toCrest, toDescent) + settings.overCrestLiftMetres * overCrest * overCrest;
    distance += (settings.landedDistanceMetres - distance) * landing;
    const cosine = Math.cos(bearing);
    const sine = Math.sin(bearing);
    const awayX = travelX * cosine - travelZ * sine;
    const awayZ = travelX * sine + travelZ * cosine;
    out.position[0] = bodyX + awayX * distance;
    out.position[2] = bodyZ + awayZ * distance;
    out.position[1] = bodyY + height;
    const landedHeight = ride.waterLevelMetres + settings.landedHeightAboveWaterMetres;
    out.position[1] += (landedHeight - out.position[1]) * landing;
    out.position[1] = Math.max(out.position[1], ride.surfaceAt(out.position[0], out.position[2]) + settings.rideClearOfWaterMetres);
    return lookAt(out, bodyX, bodyY + settings.lookAboveBodyMetres, bodyZ);
}

export function landedRideSeconds(settings = waveCameraSettings, rideSettings = waveRideSettings) {
    return rideSettings.splashdownSeconds + settings.landingFromSplashdownSeconds[1];
}

export function waveCameraPose(state, astronaut, helmet, crestElevationRadians, waterLevelMetres, out, ride = null, settings = waveCameraSettings) {
    if (state.phase === WAVE_PHASE_RIDE && ride) {
        return rideCameraPose(-state.secondsBeforeImpact, ride, out, settings);
    }
    if (state.phase === WAVE_PHASE_DRAIN && ride) {
        return rideCameraPose(landedRideSeconds(settings), ride, out, settings);
    }
    const yaw = astronaut.yawRadians;
    const forwardX = Math.sin(yaw);
    const forwardZ = Math.cos(yaw);
    const seconds = state.phase === WAVE_PHASE_BRACE ? state.secondsIntoPhase : 0;
    const orbit = smoothstep(settings.orbitStartSeconds, settings.orbitEndSeconds, seconds);
    const angle = Math.PI + (settings.frontAngleRadians - Math.PI) * orbit;
    const distance = settings.behindDistanceMetres + (settings.frontDistanceMetres - settings.behindDistanceMetres) * orbit;
    const behindHeight = waterLevelMetres + settings.behindHeightAboveWaterMetres;
    const frontHeight = helmet[1] + settings.frontHeightAboveHelmetMetres;
    const sideOffset = settings.behindSideMetres * (1 - orbit);
    const rightX = Math.cos(yaw);
    const rightZ = -Math.sin(yaw);
    out.position[0] = astronaut.x + Math.sin(yaw + angle) * distance + rightX * sideOffset;
    out.position[1] = behindHeight + (frontHeight - behindHeight) * orbit;
    out.position[2] = astronaut.z + Math.cos(yaw + angle) * distance + rightZ * sideOffset;
    const lookUp = Math.min(settings.lookUpMaximumRadians, Math.max(settings.lookUpMinimumRadians, crestElevationRadians * settings.lookUpOfCrest));
    const towardWaveX = forwardX * Math.cos(lookUp);
    const towardWaveY = Math.sin(lookUp);
    const towardWaveZ = forwardZ * Math.cos(lookUp);
    let towardHelmetX = helmet[0] - out.position[0];
    let towardHelmetY = helmet[1] - out.position[1];
    let towardHelmetZ = helmet[2] - out.position[2];
    const helmetDistance = Math.hypot(towardHelmetX, towardHelmetY, towardHelmetZ) || 1;
    towardHelmetX /= helmetDistance;
    towardHelmetY /= helmetDistance;
    towardHelmetZ /= helmetDistance;
    const angles = lookAngles(
        towardWaveX + (towardHelmetX - towardWaveX) * orbit,
        towardWaveY + (towardHelmetY - towardWaveY) * orbit,
        towardWaveZ + (towardHelmetZ - towardWaveZ) * orbit,
        out.scratchAngles,
    );
    out.yawRadians = angles[0];
    out.pitchRadians = angles[1];
    const returnToRide = smoothstep(settings.returnStartSeconds, settings.returnEndSeconds, seconds);
    if (returnToRide > 0 && ride) {
        const rideStart = rideCameraPose(0, ride, out.rideScratch, settings);
        blendCameraPoseAroundPivot(out, rideStart, helmet[0], helmet[2], returnToRide, out.blendScratch);
    }
    return out;
}

export function createWaveCameraPose() {
    return {
        position: new Float64Array(3),
        yawRadians: 0,
        pitchRadians: 0,
        scratchAngles: new Float64Array(2),
        rideScratch: { position: new Float64Array(3), yawRadians: 0, pitchRadians: 0, scratchAngles: new Float64Array(2) },
        blendScratch: { from: {}, to: {} },
    };
}

const pivotTooCloseForBearingMetres = 0.3;

function wrapAngle(radians) {
    return Math.atan2(Math.sin(radians), Math.cos(radians));
}

function orbitAroundPivot(pose, pivotX, pivotZ, out) {
    const offsetX = pose.position[0] - pivotX;
    const offsetZ = pose.position[2] - pivotZ;
    out.distance = Math.hypot(offsetX, offsetZ);
    out.bearing = out.distance < pivotTooCloseForBearingMetres ? pose.yawRadians + Math.PI : Math.atan2(offsetX, offsetZ);
    out.lookOffset = wrapAngle(pose.yawRadians - out.bearing - Math.PI);
    out.offPivotX = offsetX - Math.sin(out.bearing) * out.distance;
    out.offPivotZ = offsetZ - Math.cos(out.bearing) * out.distance;
    return out;
}

export function createCameraBlendScratch() {
    return { from: {}, to: {} };
}

export function blendCameraPoseAroundPivot(target, scripted, pivotX, pivotZ, weight, scratch) {
    const from = orbitAroundPivot(target, pivotX, pivotZ, scratch.from);
    const to = orbitAroundPivot(scripted, pivotX, pivotZ, scratch.to);
    const bearing = from.bearing + wrapAngle(to.bearing - from.bearing) * weight;
    const distance = from.distance + (to.distance - from.distance) * weight;
    const lookOffset = from.lookOffset + wrapAngle(to.lookOffset - from.lookOffset) * weight;
    target.position[0] = pivotX + Math.sin(bearing) * distance + from.offPivotX * (1 - weight) + to.offPivotX * weight;
    target.position[1] += (scripted.position[1] - target.position[1]) * weight;
    target.position[2] = pivotZ + Math.cos(bearing) * distance + from.offPivotZ * (1 - weight) + to.offPivotZ * weight;
    target.yawRadians = bearing + Math.PI + lookOffset;
    target.pitchRadians += (scripted.pitchRadians - target.pitchRadians) * weight;
    return target;
}
