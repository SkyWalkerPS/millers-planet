export const waveSchedule = {
    firstImpactSeconds: 300,
    periodSeconds: 300,
    approachSeconds: 60,
    braceSeconds: 8,
    underwaterSeconds: 5,
    drainSeconds: 6,
};

export const wavePath = {
    heightMetres: 2400,
    parkedDistanceMetres: 13000,
    risingStartDistanceMetres: 30000,
    risingSeconds: 120,
    risingHeightSeconds: 45,
    passingSpeedMetresPerSecond: 200,
    approachKnotSeconds: [0, 8, 20, 60],
    approachKnotDistances: [0, 1700, 4400, 13000],
    approachKnotSpeeds: [200, 215, 240, 180],
    recedingSinkStartMetres: 20000,
    recedingSinkEndMetres: 40000,
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

function hermite(startValue, endValue, startSlope, endSlope, span, fraction) {
    const squared = fraction * fraction;
    const cubed = squared * fraction;
    return (2 * cubed - 3 * squared + 1) * startValue + (cubed - 2 * squared + fraction) * span * startSlope + (-2 * cubed + 3 * squared) * endValue + (cubed - squared) * span * endSlope;
}

export function approachDistanceMetres(secondsBeforeImpact, path = wavePath) {
    const knots = path.approachKnotSeconds;
    const last = knots.length - 1;
    if (secondsBeforeImpact >= knots[last]) {
        return path.approachKnotDistances[last];
    }
    let segment = 0;
    while (segment < last - 1 && secondsBeforeImpact > knots[segment + 1]) {
        segment++;
    }
    const span = knots[segment + 1] - knots[segment];
    const fraction = (secondsBeforeImpact - knots[segment]) / span;
    return hermite(path.approachKnotDistances[segment], path.approachKnotDistances[segment + 1], path.approachKnotSpeeds[segment], path.approachKnotSpeeds[segment + 1], span, fraction);
}

export function frontDistanceMetres(waveIndex, secondsBeforeImpact, schedule = waveSchedule, path = wavePath) {
    if (secondsBeforeImpact <= 0) {
        return path.passingSpeedMetresPerSecond * secondsBeforeImpact;
    }
    if (secondsBeforeImpact <= schedule.approachSeconds) {
        return approachDistanceMetres(secondsBeforeImpact, path);
    }
    if (waveIndex === 1) {
        return path.parkedDistanceMetres;
    }
    const calmSeconds = schedule.periodSeconds - settleSecondsOf(schedule) - schedule.approachSeconds;
    const secondsIntoCalm = calmSeconds - (secondsBeforeImpact - schedule.approachSeconds);
    const fraction = Math.min(1, Math.max(0, secondsIntoCalm / path.risingSeconds));
    const eased = 1 - (1 - fraction) * (1 - fraction) * (1 - fraction);
    return path.risingStartDistanceMetres + (path.parkedDistanceMetres - path.risingStartDistanceMetres) * eased;
}

function smoothFraction(value) {
    const clamped = Math.min(1, Math.max(0, value));
    return clamped * clamped * (3 - 2 * clamped);
}

export function heightFractionOf(waveIndex, secondsBeforeImpact, schedule = waveSchedule, path = wavePath) {
    if (secondsBeforeImpact <= 0) {
        const distanceAway = path.passingSpeedMetresPerSecond * -secondsBeforeImpact;
        return 1 - smoothFraction((distanceAway - path.recedingSinkStartMetres) / (path.recedingSinkEndMetres - path.recedingSinkStartMetres));
    }
    if (waveIndex === 1 || secondsBeforeImpact <= schedule.approachSeconds) {
        return 1;
    }
    const calmSeconds = schedule.periodSeconds - settleSecondsOf(schedule) - schedule.approachSeconds;
    const secondsIntoCalm = calmSeconds - (secondsBeforeImpact - schedule.approachSeconds);
    return smoothFraction(secondsIntoCalm / path.risingHeightSeconds);
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
