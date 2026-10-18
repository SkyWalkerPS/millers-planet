export const BLACKBODY_TABLE_SIZE = 512;
export const BLACKBODY_LOG2_MIN = Math.log2(250);
export const BLACKBODY_LOG2_MAX = Math.log2(400000);

const degreesToRadians = Math.PI / 180;

export function horizonRadius(spin) {
    return 1 + Math.sqrt(1 - spin * spin);
}

export function iscoRadius(spin) {
    const z1 = 1 + Math.cbrt(1 - spin * spin) * (Math.cbrt(1 + spin) + Math.cbrt(1 - spin));
    const z2 = Math.sqrt(3 * spin * spin + z1 * z1);
    return 3 + z2 - Math.sqrt((3 - z1) * (3 + z1 + 2 * z2));
}

export function pageThorneDiskModel(spin) {
    const a = Math.min(Math.max(spin, 1e-4), 0.9985);
    const innerRadius = iscoRadius(a);
    const x0 = Math.sqrt(innerRadius);
    const third = Math.acos(a) / 3;
    const x1 = 2 * Math.cos(third - Math.PI / 3);
    const x2 = 2 * Math.cos(third + Math.PI / 3);
    const x3 = -2 * Math.cos(third);
    const weight1 = (3 * (x1 - a) ** 2) / (x1 * (x1 - x2) * (x1 - x3));
    const weight2 = (3 * (x2 - a) ** 2) / (x2 * (x2 - x1) * (x2 - x3));
    const weight3 = (3 * (x3 - a) ** 2) / (x3 * (x3 - x1) * (x3 - x2));
    const flux = (radius) => {
        const x = Math.sqrt(radius);
        if (x <= x0) {
            return 0;
        }
        const bracket = x - x0 - 1.5 * a * Math.log(x / x0)
            - weight1 * Math.log((x - x1) / (x0 - x1))
            - weight2 * Math.log((x - x2) / (x0 - x2))
            - weight3 * Math.log((x - x3) / (x0 - x3));
        return Math.max(bracket, 0) / (x ** 4 * (x ** 3 - 3 * x + 2 * a));
    };
    let maxFlux = 0;
    let peakRadius = innerRadius;
    for (let index = 1; index <= 6000; index++) {
        const radius = innerRadius * Math.pow(40, index / 6000);
        const value = flux(radius);
        if (value > maxFlux) {
            maxFlux = value;
            peakRadius = radius;
        }
    }
    return {
        spin: a, innerRadius, peakRadius, maxFlux, flux,
        x0, x1, x2, x3, weight1, weight2, weight3,
        logX0: Math.log(x0), logOffset1: Math.log(x0 - x1), logOffset2: Math.log(x0 - x2), logOffset3: Math.log(x0 - x3),
    };
}

function piecewiseGaussian(x, mean, sigmaBelow, sigmaAbove) {
    const t = (x - mean) / (x < mean ? sigmaBelow : sigmaAbove);
    return Math.exp(-0.5 * t * t);
}

function cieColorMatching(wavelengthNm) {
    return [
        1.056 * piecewiseGaussian(wavelengthNm, 599.8, 37.9, 31.0) + 0.362 * piecewiseGaussian(wavelengthNm, 442.0, 16.0, 26.7) - 0.065 * piecewiseGaussian(wavelengthNm, 501.1, 20.4, 26.2),
        0.821 * piecewiseGaussian(wavelengthNm, 568.8, 46.9, 40.5) + 0.286 * piecewiseGaussian(wavelengthNm, 530.9, 16.3, 31.1),
        1.217 * piecewiseGaussian(wavelengthNm, 437.0, 11.8, 36.0) + 0.681 * piecewiseGaussian(wavelengthNm, 459.0, 26.0, 13.8),
    ];
}

function blackbodyXyz(temperature) {
    const xyz = [0, 0, 0];
    for (let wavelengthNm = 360; wavelengthNm <= 830; wavelengthNm += 2) {
        const wavelength = wavelengthNm * 1e-9;
        const exponent = 1.4387769e-2 / (wavelength * temperature);
        if (exponent > 700) {
            continue;
        }
        const spectralRadiance = 1 / (wavelength ** 5 * Math.expm1(exponent));
        const matching = cieColorMatching(wavelengthNm);
        for (let channel = 0; channel < 3; channel++) {
            xyz[channel] += spectralRadiance * matching[channel];
        }
    }
    return xyz;
}

function xyzToLinearSrgb([x, y, z]) {
    return [
        3.2406 * x - 1.5372 * y - 0.4986 * z,
        -0.9689 * x + 1.8758 * y + 0.0415 * z,
        0.0557 * x - 0.2040 * y + 1.0570 * z,
    ];
}

export function buildBlackbodyTable() {
    const table = new Float32Array(BLACKBODY_TABLE_SIZE * 4);
    const referenceLuminance = blackbodyXyz(6500)[1];
    for (let index = 0; index < BLACKBODY_TABLE_SIZE; index++) {
        const temperature = 2 ** (BLACKBODY_LOG2_MIN + (BLACKBODY_LOG2_MAX - BLACKBODY_LOG2_MIN) * (index / (BLACKBODY_TABLE_SIZE - 1)));
        const xyz = blackbodyXyz(temperature);
        const luminance = xyz[1];
        const chromaticity = luminance > 0 ? xyzToLinearSrgb([xyz[0] / luminance, 1, xyz[2] / luminance]).map((value) => Math.max(value, 0)) : [1, 0, 0];
        const clampedLuminance = 0.2126 * chromaticity[0] + 0.7152 * chromaticity[1] + 0.0722 * chromaticity[2];
        table.set([
            chromaticity[0] / clampedLuminance,
            chromaticity[1] / clampedLuminance,
            chromaticity[2] / clampedLuminance,
            Math.log2(Math.max(luminance / referenceLuminance, 1e-37)),
        ], index * 4);
    }
    return table;
}

function dotProduct(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function crossProduct(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalizeVector(v) {
    const length = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / length, v[1] / length, v[2] / length];
}

function boyerLindquistRadius(spin, positionBh) {
    const [x, y, z] = positionBh;
    const squaredDistance = x * x + y * y + z * z;
    const offset = squaredDistance - spin * spin;
    const radiusSquared = 0.5 * (offset + Math.sqrt(offset * offset + 4 * spin * spin * z * z));
    return Math.sqrt(Math.max(radiusSquared, 1e-12));
}

export function observerFrame(spin, positionBh) {
    const r = boyerLindquistRadius(spin, positionBh);
    const cosTheta = Math.min(Math.max(positionBh[2] / r, -0.999999), 0.999999);
    const sinTheta = Math.sqrt(1 - cosTheta * cosTheta);
    const phi = Math.atan2(positionBh[1], positionBh[0]);
    const cosPhi = Math.cos(phi);
    const sinPhi = Math.sin(phi);
    const sigma = r * r + spin * spin * cosTheta * cosTheta;
    const delta = r * r - 2 * r + spin * spin;
    const bigA = (r * r + spin * spin) ** 2 - spin * spin * delta * sinTheta * sinTheta;
    const lapse = Math.sqrt((sigma * delta) / bigA);
    const frameDragOmega = (2 * spin * r) / bigA;
    const cylindricalRadius = Math.sqrt(bigA / sigma) * sinTheta;
    const spheroidalRadius = Math.sqrt(r * r + spin * spin);
    return {
        r, sinTheta, cosTheta, phi, sigma, delta, bigA, lapse, frameDragOmega, cylindricalRadius,
        sphereUnit: [sinTheta * cosPhi, sinTheta * sinPhi, cosTheta],
        sphereThetaHat: [cosTheta * cosPhi, cosTheta * sinPhi, -sinTheta],
        phiHat: [-sinPhi, cosPhi, 0],
        radialHat: normalizeVector([(r / spheroidalRadius) * sinTheta * cosPhi, (r / spheroidalRadius) * sinTheta * sinPhi, cosTheta]),
        polarHat: normalizeVector([spheroidalRadius * cosTheta * cosPhi, spheroidalRadius * cosTheta * sinPhi, -r * sinTheta]),
    };
}

export function rendererAxesForUntiltedBlackHole() {
    return { x: [1, 0, 0], y: [0, 0, -1], z: [0, 1, 0] };
}

export function toBlackHoleFrame(axes, vector) {
    return [dotProduct(vector, axes.x), dotProduct(vector, axes.y), dotProduct(vector, axes.z)];
}

export function orbitObserverBasis(distance, azimuthRadians, elevationRadians) {
    const cosineElevation = Math.cos(elevationRadians);
    const position = [
        distance * cosineElevation * Math.sin(azimuthRadians),
        distance * Math.sin(elevationRadians),
        distance * cosineElevation * Math.cos(azimuthRadians),
    ];
    const forward = normalizeVector(position.map((value) => -value));
    const right = normalizeVector(crossProduct(forward, [0, 1, 0]));
    const up = crossProduct(right, forward);
    return { position, forward, right, up };
}

export const gargantuaUniformFields = [
    ["cameraSphereUnit", "vec3f"], ["cameraInverseRadius", "f32"],
    ["cameraSphereThetaHat", "vec3f"], ["cameraSqrtSigma", "f32"],
    ["cameraPhiHat", "vec3f"], ["cameraAzimuthalScale", "f32"],
    ["cameraRadialHat", "vec3f"], ["cameraRadialRateScale", "f32"],
    ["cameraPolarHat", "vec3f"], ["cameraLapse", "f32"],
    ["cameraRight", "vec3f"], ["cameraFrameDragVelocity", "f32"],
    ["cameraUp", "vec3f"], ["cameraCylindricalRadius", "f32"],
    ["cameraForward", "vec3f"], ["cameraCosThetaSquared", "f32"],
    ["cameraAOverSigma", "f32"], ["tanHalfFovY", "f32"], ["aspectRatio", "f32"], ["spin", "f32"],
    ["horizonStopW", "f32"], ["diskInnerRadius", "f32"], ["diskOuterRadius", "f32"], ["fluxX0", "f32"],
    ["fluxX1", "f32"], ["fluxX2", "f32"], ["fluxX3", "f32"], ["fluxWeight1", "f32"],
    ["fluxWeight2", "f32"], ["fluxWeight3", "f32"], ["inverseMaxFlux", "f32"], ["fluxLogX0", "f32"],
    ["fluxLogOffset1", "f32"], ["fluxLogOffset2", "f32"], ["fluxLogOffset3", "f32"], ["diskPeakTemperature", "f32"],
    ["diskOpacity", "f32"], ["diskTime", "f32"], ["cinematicColor", "f32"], ["stepAngleNear", "f32"],
    ["stepAngleFar", "f32"], ["maxSteps", "f32"], ["stepRadialSpan", "f32"], ["horizonW", "f32"],
    ["internalSize", "vec2f"], ["diskZoneW", "f32"], ["turbulenceLoopPeriod", "f32"],
    ["debugView", "f32"], ["earlyEscape", "f32"], ["diskOuterW", "f32"], ["unusedPadding", "f32"],
];

export function layoutUniformStruct(structName, fields) {
    const typeLayout = { f32: [4, 4], vec2f: [8, 8], vec3f: [12, 16], vec4f: [16, 16] };
    const offsets = {};
    const members = [];
    let byteOffset = 0;
    for (const [name, type] of fields) {
        const [size, alignment] = typeLayout[type];
        byteOffset = Math.ceil(byteOffset / alignment) * alignment;
        offsets[name] = byteOffset / 4;
        byteOffset += size;
        members.push(`    ${name}: ${type},`);
    }
    const byteSize = Math.ceil(byteOffset / 16) * 16;
    return { offsets, byteSize, floatCount: byteSize / 4, wgsl: `struct ${structName} {\n${members.join("\n")}\n};\n` };
}

export class GargantuaUniformWriter {
    constructor() {
        this.layout = layoutUniformStruct("GargantuaUniforms", gargantuaUniformFields);
        this.data = new Float32Array(this.layout.floatCount);
    }

    set(name, value) {
        const offset = this.layout.offsets[name];
        if (offset === undefined) {
            throw new Error(`Unknown Gargantua uniform ${name}`);
        }
        if (typeof value === "number") {
            this.data[offset] = value;
        } else {
            this.data.set(value, offset);
        }
    }

    writeObserver(spin, frame, basisBh) {
        this.set("cameraSphereUnit", frame.sphereUnit);
        this.set("cameraInverseRadius", 1 / frame.r);
        this.set("cameraSphereThetaHat", frame.sphereThetaHat);
        this.set("cameraSqrtSigma", Math.sqrt(frame.sigma));
        this.set("cameraPhiHat", frame.phiHat);
        this.set("cameraAzimuthalScale", Math.sqrt(frame.bigA / frame.sigma));
        this.set("cameraRadialHat", frame.radialHat);
        this.set("cameraRadialRateScale", Math.sqrt(frame.sigma * frame.delta) / (frame.r * frame.r));
        this.set("cameraPolarHat", frame.polarHat);
        this.set("cameraLapse", frame.lapse);
        this.set("cameraRight", basisBh.right);
        this.set("cameraFrameDragVelocity", frame.frameDragOmega * frame.cylindricalRadius);
        this.set("cameraUp", basisBh.up);
        this.set("cameraCylindricalRadius", frame.cylindricalRadius);
        this.set("cameraForward", basisBh.forward);
        this.set("cameraCosThetaSquared", frame.cosTheta * frame.cosTheta);
        this.set("cameraAOverSigma", frame.bigA / frame.sigma);
        this.set("spin", spin);
        this.set("horizonStopW", 1 / (horizonRadius(spin) * 1.003));
        this.set("horizonW", 1 / horizonRadius(spin));
        this.set("diskZoneW", 1 / (0.95 * iscoRadius(Math.max(spin, 0))));
    }

    writeDisk(model, outerRadius, peakTemperature, cinematicColour) {
        this.set("diskInnerRadius", model.innerRadius);
        this.set("diskOuterRadius", outerRadius);
        this.set("diskOuterW", 1 / outerRadius);
        this.set("fluxX0", model.x0);
        this.set("fluxX1", model.x1);
        this.set("fluxX2", model.x2);
        this.set("fluxX3", model.x3);
        this.set("fluxWeight1", model.weight1);
        this.set("fluxWeight2", model.weight2);
        this.set("fluxWeight3", model.weight3);
        this.set("inverseMaxFlux", 1 / model.maxFlux);
        this.set("fluxLogX0", model.logX0);
        this.set("fluxLogOffset1", model.logOffset1);
        this.set("fluxLogOffset2", model.logOffset2);
        this.set("fluxLogOffset3", model.logOffset3);
        this.set("diskPeakTemperature", peakTemperature);
        this.set("diskOpacity", 2.2);
        this.set("cinematicColor", cinematicColour ? 1 : 0);
    }

    writeSteps(maxSteps, angleScale = 1) {
        const quality = 192 / Math.min(Math.max(maxSteps, 32), 512);
        const effectiveAngleScale = angleScale * Math.min(Math.max(Math.sqrt(quality), 0.75), 1.6);
        this.set("stepAngleNear", 0.1 * effectiveAngleScale);
        this.set("stepAngleFar", 0.35 * effectiveAngleScale);
        this.set("maxSteps", maxSteps);
        this.set("stepRadialSpan", 0.1);
    }

    writeView(patchWidth, patchHeight, tanHalfX, tanHalfY) {
        this.set("tanHalfFovY", tanHalfY);
        this.set("aspectRatio", tanHalfX / tanHalfY);
        this.set("internalSize", [patchWidth, patchHeight]);
    }
}

export function degrees(value) {
    return value * degreesToRadians;
}
