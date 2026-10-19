export const waveSchedule = {
    firstImpactSeconds: 240,
    periodSeconds: 240,
    approachSeconds: 60,
    braceSeconds: 8,
    underwaterSeconds: 5,
    drainSeconds: 6,
};

export const wavePath = {
    heightMetres: 2400,
    speedMetresPerSecond: 200,
    fullHeightWithinMetres: 44000,
    vanishedBeyondMetres: 50000,
    risingSeconds: 20,
};

export const WAVE_PHASE_CALM = 0;
export const WAVE_PHASE_APPROACH = 1;
export const WAVE_PHASE_BRACE = 2;
export const WAVE_PHASE_UNDERWATER = 3;
export const WAVE_PHASE_DRAIN = 4;
export const wavePhaseNames = ["calm", "approach", "brace", "underwater", "drain"];
export const wavePhaseLetters = ["", "a", "b", "c", "d"];

export function impactSecondsOf(waveIndex, schedule = waveSchedule) {
    return schedule.firstImpactSeconds + (waveIndex - 1) * schedule.periodSeconds;
}

export function settleSecondsOf(schedule = waveSchedule) {
    return schedule.underwaterSeconds + schedule.drainSeconds;
}

export function activeWaveIndexAt(seconds, schedule = waveSchedule) {
    return Math.max(1, Math.floor((seconds - schedule.firstImpactSeconds - settleSecondsOf(schedule)) / schedule.periodSeconds) + 2);
}

export function frontDistanceMetres(waveIndex, secondsBeforeImpact, schedule = waveSchedule, path = wavePath) {
    return path.speedMetresPerSecond * secondsBeforeImpact;
}

function smoothFraction(value) {
    const clamped = Math.min(1, Math.max(0, value));
    return clamped * clamped * (3 - 2 * clamped);
}

export function heightFractionOf(waveIndex, secondsBeforeImpact, schedule = waveSchedule, path = wavePath) {
    const distance = Math.abs(frontDistanceMetres(waveIndex, secondsBeforeImpact, schedule, path));
    const distanceFraction = 1 - smoothFraction((distance - path.fullHeightWithinMetres) / (path.vanishedBeyondMetres - path.fullHeightWithinMetres));
    if (secondsBeforeImpact <= 0 || waveIndex === 1) {
        return distanceFraction;
    }
    const secondsSinceAppearing = schedule.periodSeconds - settleSecondsOf(schedule) - secondsBeforeImpact;
    return distanceFraction * smoothFraction(secondsSinceAppearing / path.risingSeconds);
}

export function createWaveState() {
    return {
        index: 1,
        phase: WAVE_PHASE_CALM,
        phaseName: wavePhaseNames[WAVE_PHASE_CALM],
        impactSeconds: 0,
        secondsBeforeImpact: 0,
        phaseStartSeconds: 0,
        phaseEndSeconds: 0,
        secondsIntoPhase: 0,
        frontDistanceMetres: 0,
        heightFraction: 1,
        previousIndex: 0,
        previousFrontDistanceMetres: 0,
        previousHeightFraction: 0,
    };
}

export function waveStateAt(seconds, out = createWaveState(), schedule = waveSchedule, path = wavePath) {
    const index = activeWaveIndexAt(seconds, schedule);
    const impact = impactSecondsOf(index, schedule);
    const secondsBeforeImpact = impact - seconds;
    let phase;
    let start;
    let end;
    if (secondsBeforeImpact > schedule.approachSeconds) {
        phase = WAVE_PHASE_CALM;
        start = index === 1 ? 0 : impactSecondsOf(index - 1, schedule) + settleSecondsOf(schedule);
        end = impact - schedule.approachSeconds;
    } else if (secondsBeforeImpact > schedule.braceSeconds) {
        phase = WAVE_PHASE_APPROACH;
        start = impact - schedule.approachSeconds;
        end = impact - schedule.braceSeconds;
    } else if (secondsBeforeImpact > 0) {
        phase = WAVE_PHASE_BRACE;
        start = impact - schedule.braceSeconds;
        end = impact;
    } else if (secondsBeforeImpact > -schedule.underwaterSeconds) {
        phase = WAVE_PHASE_UNDERWATER;
        start = impact;
        end = impact + schedule.underwaterSeconds;
    } else {
        phase = WAVE_PHASE_DRAIN;
        start = impact + schedule.underwaterSeconds;
        end = impact + settleSecondsOf(schedule);
    }
    out.index = index;
    out.phase = phase;
    out.phaseName = wavePhaseNames[phase];
    out.impactSeconds = impact;
    out.secondsBeforeImpact = secondsBeforeImpact;
    out.phaseStartSeconds = start;
    out.phaseEndSeconds = end;
    out.secondsIntoPhase = seconds - start;
    out.frontDistanceMetres = frontDistanceMetres(index, secondsBeforeImpact, schedule, path);
    out.previousIndex = index - 1;
    out.heightFraction = heightFractionOf(index, secondsBeforeImpact, schedule, path);
    out.previousFrontDistanceMetres = index > 1 ? frontDistanceMetres(index - 1, impactSecondsOf(index - 1, schedule) - seconds, schedule, path) : 0;
    out.previousHeightFraction = index > 1 ? heightFractionOf(index - 1, impactSecondsOf(index - 1, schedule) - seconds, schedule, path) : 0;
    return out;
}

export function secondsForPhase(waveIndex, phaseName, secondsIntoPhase = 0, schedule = waveSchedule) {
    const impact = impactSecondsOf(waveIndex, schedule);
    const phaseStarts = {
        calm: waveIndex === 1 ? 0 : impactSecondsOf(waveIndex - 1, schedule) + settleSecondsOf(schedule),
        approach: impact - schedule.approachSeconds,
        a: impact - schedule.approachSeconds,
        brace: impact - schedule.braceSeconds,
        b: impact - schedule.braceSeconds,
        underwater: impact,
        c: impact,
        drain: impact + schedule.underwaterSeconds,
        d: impact + schedule.underwaterSeconds,
        impact,
    };
    if (!(phaseName in phaseStarts)) {
        throw new Error(`Unknown wave phase "${phaseName}" (use calm, a/approach, b/brace, c/underwater, d/drain or impact)`);
    }
    return phaseStarts[phaseName] + secondsIntoPhase;
}

export function shipStateAfterWaves(completedWaves) {
    return Math.min(Math.max(completedWaves, 0), 4);
}
