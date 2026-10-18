export function dispersionOperatorOfWavenumber(wavenumber, depthMetres, gravity, surfaceTensionOverDensity) {
    return wavenumber * Math.tanh(Math.min(wavenumber * depthMetres, 10)) * (1 + (surfaceTensionOverDensity / gravity) * wavenumber * wavenumber);
}

export function buildRippleKernel({ texelMetres, depthMetres, gravity, surfaceTensionOverDensity, radius = 6, samplesPerAxis = 96 }) {
    const nyquistWavenumber = Math.PI / texelMetres;
    const side = radius * 2 + 1;
    const weights = new Float32Array(side * side);
    const sampledOperator = new Float64Array(samplesPerAxis * samplesPerAxis);
    const sampledX = new Float64Array(samplesPerAxis);
    for (let index = 0; index < samplesPerAxis; index++) {
        sampledX[index] = ((index + 0.5) / samplesPerAxis * 2 - 1) * nyquistWavenumber;
    }
    for (let row = 0; row < samplesPerAxis; row++) {
        for (let column = 0; column < samplesPerAxis; column++) {
            sampledOperator[row * samplesPerAxis + column] = dispersionOperatorOfWavenumber(Math.hypot(sampledX[column], sampledX[row]), depthMetres, gravity, surfaceTensionOverDensity);
        }
    }
    let sum = 0;
    for (let offsetZ = -radius; offsetZ <= radius; offsetZ++) {
        for (let offsetX = -radius; offsetX <= radius; offsetX++) {
            let weight = 0;
            for (let row = 0; row < samplesPerAxis; row++) {
                for (let column = 0; column < samplesPerAxis; column++) {
                    weight += sampledOperator[row * samplesPerAxis + column] * Math.cos((sampledX[column] * offsetX + sampledX[row] * offsetZ) * texelMetres);
                }
            }
            weight /= samplesPerAxis * samplesPerAxis;
            weights[(offsetZ + radius) * side + (offsetX + radius)] = weight;
            sum += weight;
        }
    }
    weights[radius * side + radius] -= sum;
    return { weights, radius, side };
}
