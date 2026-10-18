import { WAVE_PHASE_BRACE, WAVE_PHASE_DRAIN, WAVE_PHASE_UNDERWATER } from "../wave/waveTimeline.js";

const degrees = Math.PI / 180;

export const waveCameraSettings = {
    blendInSeconds: 1.2,
    behindDistanceMetres: 3.2,
    behindSideMetres: 0.55,
    behindHeightAboveWaterMetres: 0.6,
    lookUpMinimumRadians: 12 * degrees,
    lookUpMaximumRadians: 24 * degrees,
    lookUpOfCrest: 0.45,
    orbitStartSeconds: 4,
    orbitEndSeconds: 6.5,
    frontAngleRadians: 0.48,
    frontDistanceMetres: 1.6,
    frontHeightAboveHelmetMetres: 0.05,
    underwaterBehindMetres: 2.1,
    underwaterHeightMetres: 0.25,
    underwaterPitchRadians: 33 * degrees,
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
    if (state.phase === WAVE_PHASE_UNDERWATER) {
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
    if (state.phase === WAVE_PHASE_UNDERWATER) {
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
    return state.phase === WAVE_PHASE_BRACE || state.phase === WAVE_PHASE_UNDERWATER || state.phase === WAVE_PHASE_DRAIN;
}

function lookAngles(directionX, directionY, directionZ, out) {
    out[0] = Math.atan2(directionX, directionZ);
    out[1] = Math.atan2(directionY, Math.hypot(directionX, directionZ));
    return out;
}

export function waveCameraPose(state, astronaut, helmet, crestElevationRadians, waterLevelMetres, out, settings = waveCameraSettings) {
    const yaw = astronaut.yawRadians;
    const forwardX = Math.sin(yaw);
    const forwardZ = Math.cos(yaw);
    if (state.phase === WAVE_PHASE_UNDERWATER || state.phase === WAVE_PHASE_DRAIN) {
        out.position[0] = astronaut.x - forwardX * settings.underwaterBehindMetres;
        out.position[1] = astronaut.groundY + settings.underwaterHeightMetres + 0.6;
        out.position[2] = astronaut.z - forwardZ * settings.underwaterBehindMetres;
        out.yawRadians = yaw;
        out.pitchRadians = settings.underwaterPitchRadians;
        return out;
    }
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
    return out;
}

export function createWaveCameraPose() {
    return { position: new Float64Array(3), yawRadians: 0, pitchRadians: 0, scratchAngles: new Float64Array(2) };
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
