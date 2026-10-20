export const waveMeshLayout = {
    acrossSegments: 96,
    extraExtentMetres: 40,
    beyondToeHeightMetres: -0.6,
};

export const waveRideSettings = {
    rideSeconds: 11.0,
    crestCrossingSeconds: 4.2,
    splashdownSeconds: 9.4,
    knockedOffFeetSpeedMetresPerSecond: 60,
    crestCrossingSpeedMetresPerSecond: 196,
    splashdownSpeedMetresPerSecond: 100,
    driftTimeConstantSeconds: 0.6,
    crestRoundingMetres: 15,
    crestLiftReachMetres: 5,
    shipRideReachMetres: 400,
    tumbleTurns: 1,
    tumbleRollRadians: 0.35,
    shipTumbleRadians: 0.55,
};

export const astronautRider = {
    clearanceMetres: 1.1,
    clearanceEaseSeconds: 0.45,
    thrownAboveCrestMetres: 20,
    thrownHalfSeconds: 1.2,
    dunks: [
        { atSeconds: 1.6, depthMetres: 3.7, halfSeconds: 0.4 },
        { atSeconds: 7.0, depthMetres: 3.7, halfSeconds: 0.4 },
    ],
};

export const shipRider = {
    clearanceMetres: 2.6,
    clearanceEaseSeconds: 0.6,
    thrownAboveCrestMetres: 12,
    thrownHalfSeconds: 1.3,
    dunks: [],
};

function hermite(startValue, endValue, startSlope, endSlope, span, fraction) {
    const squared = fraction * fraction;
    const cubed = squared * fraction;
    return (2 * cubed - 3 * squared + 1) * startValue + (cubed - 2 * squared + fraction) * span * startSlope + (-2 * cubed + 3 * squared) * endValue + (cubed - squared) * span * endSlope;
}

function smootherstep(fraction) {
    const x = Math.min(1, Math.max(0, fraction));
    return x * x * x * (x * (6 * x - 15) + 10);
}

function smoothHump(fraction) {
    const remaining = 1 - fraction * fraction;
    return remaining > 0 ? remaining * remaining : 0;
}

export function waveProfileHeight(aheadMetres, crestHeightMetres, frontWidthMetres, backWidthMetres) {
    if (aheadMetres >= 0) {
        if (aheadMetres >= frontWidthMetres) {
            return waveMeshLayout.beyondToeHeightMetres;
        }
        const remaining = 1 - aheadMetres / frontWidthMetres;
        return crestHeightMetres * remaining * remaining;
    }
    if (-aheadMetres >= backWidthMetres) {
        return waveMeshLayout.beyondToeHeightMetres;
    }
    const remaining = 1 + aheadMetres / backWidthMetres;
    return crestHeightMetres * remaining * remaining;
}

export function drawnWaveHeight(aheadMetres, crestHeightMetres, frontWidthMetres, backWidthMetres, layout = waveMeshLayout) {
    const sideWidth = aheadMetres >= 0 ? frontWidthMetres : backWidthMetres;
    const extent = sideWidth + layout.extraExtentMetres;
    const distance = Math.abs(aheadMetres);
    if (distance >= extent) {
        return layout.beyondToeHeightMetres;
    }
    const rowsPerSide = layout.acrossSegments / 2;
    const row = Math.min(rowsPerSide - 1, Math.floor(Math.sqrt(distance / extent) * rowsPerSide));
    const nearDistance = Math.pow(row / rowsPerSide, 2) * extent;
    const farDistance = Math.pow((row + 1) / rowsPerSide, 2) * extent;
    const direction = aheadMetres >= 0 ? 1 : -1;
    const nearHeight = waveProfileHeight(direction * nearDistance, crestHeightMetres, frontWidthMetres, backWidthMetres);
    const farHeight = waveProfileHeight(direction * farDistance, crestHeightMetres, frontWidthMetres, backWidthMetres);
    return nearHeight + (farHeight - nearHeight) * ((distance - nearDistance) / (farDistance - nearDistance));
}

export function drawnWaveHeightMargin(aheadMetres, crestHeightMetres, frontWidthMetres, backWidthMetres, layout = waveMeshLayout) {
    const sideWidth = aheadMetres >= 0 ? frontWidthMetres : backWidthMetres;
    const extent = sideWidth + layout.extraExtentMetres;
    const rowsPerSide = layout.acrossSegments / 2;
    const rowFraction = Math.min(1, Math.sqrt(Math.min(Math.abs(aheadMetres), extent) / extent) + 1 / rowsPerSide);
    const rowSpacing = (2 * rowFraction * extent) / rowsPerSide;
    const curvature = (2 * crestHeightMetres) / (sideWidth * sideWidth);
    return 0.125 * curvature * rowSpacing * rowSpacing + 0.05;
}

export function ridingSurface(aheadMetres, geometry, settings = waveRideSettings, out = { heightMetres: 0, slope: 0, marginMetres: 0 }) {
    const { crestHeightMetres: crest, frontWidthMetres: front, backWidthMetres: back } = geometry;
    const rounding = settings.crestRoundingMetres;
    let heightMetres;
    let slope;
    if (aheadMetres >= front || -aheadMetres >= back) {
        heightMetres = 0;
        slope = 0;
    } else {
        const frontRemaining = 1 - aheadMetres / front;
        const backRemaining = 1 + aheadMetres / back;
        const frontHeight = crest * frontRemaining * frontRemaining;
        const backHeight = crest * backRemaining * backRemaining;
        const frontSlope = (-2 * crest * frontRemaining) / front;
        const backSlope = (2 * crest * backRemaining) / back;
        const lower = Math.min(frontHeight, backHeight);
        const gap = Math.abs(frontHeight - backHeight);
        const blend = Math.exp(-gap / rounding);
        const frontWeight = frontHeight < backHeight ? 1 / (1 + blend) : blend / (1 + blend);
        const nearCrest = aheadMetres / settings.crestLiftReachMetres;
        const crestLift = (rounding * Math.LN2) / (1 + nearCrest * nearCrest);
        const crestLiftSlope = (-2 * crestLift * nearCrest) / (settings.crestLiftReachMetres * (1 + nearCrest * nearCrest));
        heightMetres = Math.max(0, lower - rounding * Math.log(1 + blend) + crestLift);
        slope = frontSlope * frontWeight + backSlope * (1 - frontWeight) + crestLiftSlope;
    }
    out.heightMetres = heightMetres;
    out.slope = slope;
    out.marginMetres = drawnWaveHeightMargin(aheadMetres, crest, front, back);
    return out;
}

export function rideAheadKnots(geometry, settings = waveRideSettings) {
    const speed = geometry.speedMetresPerSecond;
    return [
        [0, geometry.frontWidthMetres, settings.knockedOffFeetSpeedMetresPerSecond - speed],
        [settings.crestCrossingSeconds, 0, settings.crestCrossingSpeedMetresPerSecond - speed],
        [settings.splashdownSeconds, -geometry.backWidthMetres, settings.splashdownSpeedMetresPerSecond - speed],
    ];
}

export function rideAheadMetres(secondsSinceImpact, geometry, settings = waveRideSettings) {
    const seconds = Math.max(0, secondsSinceImpact);
    if (seconds >= settings.splashdownSeconds) {
        return rideTravelMetres(seconds, geometry, settings) + geometry.frontWidthMetres - geometry.speedMetresPerSecond * seconds;
    }
    const knots = rideAheadKnots(geometry, settings);
    const segment = seconds < knots[1][0] ? 0 : 1;
    const [startSeconds, startAhead, startRate] = knots[segment];
    const [endSeconds, endAhead, endRate] = knots[segment + 1];
    const span = endSeconds - startSeconds;
    return hermite(startAhead, endAhead, startRate, endRate, span, (seconds - startSeconds) / span);
}

export function rideTravelMetres(secondsSinceImpact, geometry, settings = waveRideSettings) {
    const seconds = Math.max(0, secondsSinceImpact);
    const speed = geometry.speedMetresPerSecond;
    const splashdown = settings.splashdownSeconds;
    if (seconds < splashdown) {
        return rideAheadMetres(seconds, geometry, settings) - geometry.frontWidthMetres + speed * seconds;
    }
    const travelAtSplashdown = -geometry.backWidthMetres - geometry.frontWidthMetres + speed * splashdown;
    const tau = settings.driftTimeConstantSeconds;
    return travelAtSplashdown + settings.splashdownSpeedMetresPerSecond * tau * (1 - Math.exp(-(seconds - splashdown) / tau));
}

export function rideLandingTravelMetres(geometry, settings = waveRideSettings) {
    return rideTravelMetres(settings.rideSeconds, geometry, settings);
}

function riderAboveWaterAmount(secondsSinceImpact, rider, settings) {
    const easeIn = smootherstep(secondsSinceImpact / rider.clearanceEaseSeconds);
    const easeOut = 1 - smootherstep((secondsSinceImpact - (settings.splashdownSeconds - rider.clearanceEaseSeconds)) / rider.clearanceEaseSeconds);
    return easeIn * easeOut;
}

export function riderClearanceMetres(secondsSinceImpact, rider, settings = waveRideSettings) {
    let clearance = rider.clearanceMetres * riderAboveWaterAmount(secondsSinceImpact, rider, settings);
    for (const dunk of rider.dunks) {
        clearance -= dunk.depthMetres * smoothHump((secondsSinceImpact - dunk.atSeconds) / dunk.halfSeconds);
    }
    return clearance;
}

const surfaceScratch = { heightMetres: 0, slope: 0, marginMetres: 0 };

export function rideLiftMetres(secondsSinceImpact, geometry, rider = astronautRider, aheadMetres = rideAheadMetres(secondsSinceImpact, geometry), settings = waveRideSettings) {
    if (secondsSinceImpact <= 0 || secondsSinceImpact >= settings.splashdownSeconds) {
        return 0;
    }
    const surface = ridingSurface(aheadMetres, geometry, settings, surfaceScratch);
    const clearance = (riderClearanceMetres(secondsSinceImpact, rider, settings) + surface.marginMetres * riderAboveWaterAmount(secondsSinceImpact, rider, settings)) * Math.sqrt(1 + surface.slope * surface.slope);
    const thrown = rider.thrownAboveCrestMetres * smoothHump((secondsSinceImpact - settings.crestCrossingSeconds) / rider.thrownHalfSeconds);
    return Math.max(0, surface.heightMetres + clearance + thrown);
}

export function riderIsUnderwater(secondsSinceImpact, rider = astronautRider, settings = waveRideSettings) {
    return secondsSinceImpact > 0 && secondsSinceImpact < settings.splashdownSeconds && riderClearanceMetres(secondsSinceImpact, rider, settings) < -1;
}

export function rideTumble(secondsSinceImpact, settings = waveRideSettings) {
    const fraction = Math.min(1, Math.max(0, secondsSinceImpact / settings.splashdownSeconds));
    return {
        pitchRadians: -2 * Math.PI * settings.tumbleTurns * smootherstep(fraction),
        rollRadians: settings.tumbleRollRadians * Math.sin(Math.PI * fraction) * Math.sin(3 * Math.PI * fraction),
    };
}

export function rotationAboutAxes(travelX, travelZ, pitchRadians, rollRadians, out = new Float64Array(9)) {
    const lateralX = travelZ;
    const lateralZ = -travelX;
    const pitchCosine = Math.cos(pitchRadians);
    const pitchSine = Math.sin(pitchRadians);
    const rollCosine = Math.cos(rollRadians);
    const rollSine = Math.sin(rollRadians);
    const pitch = axisRotation(lateralX, 0, lateralZ, pitchCosine, pitchSine);
    const roll = axisRotation(travelX, 0, travelZ, rollCosine, rollSine);
    for (let row = 0; row < 3; row++) {
        for (let column = 0; column < 3; column++) {
            out[row * 3 + column] = roll[row * 3] * pitch[column] + roll[row * 3 + 1] * pitch[3 + column] + roll[row * 3 + 2] * pitch[6 + column];
        }
    }
    return out;
}

function axisRotation(axisX, axisY, axisZ, cosine, sine) {
    const oneMinus = 1 - cosine;
    return [
        cosine + axisX * axisX * oneMinus, axisX * axisY * oneMinus - axisZ * sine, axisX * axisZ * oneMinus + axisY * sine,
        axisY * axisX * oneMinus + axisZ * sine, cosine + axisY * axisY * oneMinus, axisY * axisZ * oneMinus - axisX * sine,
        axisZ * axisX * oneMinus - axisY * sine, axisZ * axisY * oneMinus + axisX * sine, cosine + axisZ * axisZ * oneMinus,
    ];
}
