export const LANDER_SLOT_HULL = 0;
export const LANDER_SLOT_BELLY = 1;
export const LANDER_SLOT_GLASS = 2;
export const LANDER_SLOT_METAL = 3;
export const LANDER_SLOT_DARK = 4;
export const LANDER_SLOT_TORN = 5;
export const LANDER_SLOT_CHARCOAL = 6;
export const LANDER_SLOT_SIGNAL = 7;

export const landerDimensions = {
    noseZ: 9.0,
    hullTailZ: -7.0,
    rearModuleTailZ: -9.2,
    bellyHeightAboveWaterMetres: 1.0,
    legLengthMetres: 1.25,
};

function createRandom(seed) {
    let state = seed >>> 0 || 1;
    return () => {
        state = (Math.imul(state ^ (state >>> 15), 2246822519) + 0x9e3779b9) >>> 0;
        state ^= state >>> 13;
        state = Math.imul(state, 3266489917) >>> 0;
        state ^= state >>> 16;
        return (state >>> 0) / 4294967296;
    };
}

class Part {
    constructor(name) {
        this.name = name;
        this.positions = [];
        this.slots = [];
    }

    triangle(a, b, c, slot) {
        this.positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
        this.slots.push(slot);
    }

    quad(a, b, c, d, slot) {
        this.triangle(a, b, c, slot);
        this.triangle(a, c, d, slot);
    }

    clone(name = this.name) {
        const copy = new Part(name);
        copy.positions = this.positions.slice();
        copy.slots = this.slots.slice();
        return copy;
    }

    get triangleCount() {
        return this.slots.length;
    }

    bounds() {
        const minimum = [Infinity, Infinity, Infinity];
        const maximum = [-Infinity, -Infinity, -Infinity];
        for (let index = 0; index < this.positions.length; index += 3) {
            for (let axis = 0; axis < 3; axis++) {
                minimum[axis] = Math.min(minimum[axis], this.positions[index + axis]);
                maximum[axis] = Math.max(maximum[axis], this.positions[index + axis]);
            }
        }
        return { minimum, maximum };
    }

    filterTriangles(keep, name) {
        const result = new Part(name);
        for (let triangle = 0; triangle < this.slots.length; triangle++) {
            const offset = triangle * 9;
            const centroid = [
                (this.positions[offset] + this.positions[offset + 3] + this.positions[offset + 6]) / 3,
                (this.positions[offset + 1] + this.positions[offset + 4] + this.positions[offset + 7]) / 3,
                (this.positions[offset + 2] + this.positions[offset + 5] + this.positions[offset + 8]) / 3,
            ];
            if (keep(centroid, triangle)) {
                for (let value = 0; value < 9; value++) {
                    result.positions.push(this.positions[offset + value]);
                }
                result.slots.push(this.slots[triangle]);
            }
        }
        return result;
    }

    transformed(matrix) {
        const copy = this.clone();
        for (let index = 0; index < copy.positions.length; index += 3) {
            const [x, y, z] = [copy.positions[index], copy.positions[index + 1], copy.positions[index + 2]];
            copy.positions[index] = matrix[0] * x + matrix[3] * y + matrix[6] * z + matrix[9];
            copy.positions[index + 1] = matrix[1] * x + matrix[4] * y + matrix[7] * z + matrix[10];
            copy.positions[index + 2] = matrix[2] * x + matrix[5] * y + matrix[8] * z + matrix[11];
        }
        return copy;
    }

    dented(random, dentCount, maximumDepth, radius) {
        const copy = this.clone();
        const box = this.bounds();
        const dents = [];
        for (let dent = 0; dent < dentCount; dent++) {
            dents.push({
                centre: [0, 1, 2].map((axis) => box.minimum[axis] + random() * (box.maximum[axis] - box.minimum[axis])),
                depth: maximumDepth * (0.4 + 0.6 * random()),
                radius: radius * (0.6 + 0.8 * random()),
            });
        }
        const centreX = (box.minimum[0] + box.maximum[0]) / 2;
        const centreY = (box.minimum[1] + box.maximum[1]) / 2;
        for (let index = 0; index < copy.positions.length; index += 3) {
            let x = copy.positions[index];
            let y = copy.positions[index + 1];
            const z = copy.positions[index + 2];
            for (const dent of dents) {
                const distance = Math.hypot(x - dent.centre[0], y - dent.centre[1], z - dent.centre[2]);
                if (distance < dent.radius) {
                    const falloff = 0.5 + 0.5 * Math.cos((Math.PI * distance) / dent.radius);
                    const inwardX = centreX - x;
                    const inwardY = centreY - y;
                    const inwardLength = Math.hypot(inwardX, inwardY) || 1;
                    x += (inwardX / inwardLength) * dent.depth * falloff;
                    y += (inwardY / inwardLength) * dent.depth * falloff;
                }
            }
            copy.positions[index] = x;
            copy.positions[index + 1] = y;
        }
        return copy;
    }
}

export function rotationTranslation(yawRadians, pitchRadians, rollRadians, translationX, translationY, translationZ) {
    const cosineYaw = Math.cos(yawRadians);
    const sineYaw = Math.sin(yawRadians);
    const cosinePitch = Math.cos(pitchRadians);
    const sinePitch = Math.sin(pitchRadians);
    const cosineRoll = Math.cos(rollRadians);
    const sineRoll = Math.sin(rollRadians);
    const rightX = cosineRoll;
    const rightY = -sineRoll;
    const upX = sineRoll * cosinePitch;
    const upY = cosineRoll * cosinePitch;
    const upZ = sinePitch;
    const forwardX = sineRoll * -sinePitch;
    const forwardY = cosineRoll * -sinePitch;
    const forwardZ = cosinePitch;
    const yawed = (x, y, z) => [x * cosineYaw + z * sineYaw, y, -x * sineYaw + z * cosineYaw];
    const xAxis = yawed(rightX, rightY, 0);
    const yAxis = yawed(upX, upY, upZ);
    const zAxis = yawed(forwardX, forwardY, forwardZ);
    return [...xAxis, ...yAxis, ...zAxis, translationX, translationY, translationZ];
}

export function composeTransforms(outer, inner) {
    const result = new Array(12);
    for (let column = 0; column < 3; column++) {
        for (let row = 0; row < 3; row++) {
            result[column * 3 + row] = outer[row] * inner[column * 3] + outer[3 + row] * inner[column * 3 + 1] + outer[6 + row] * inner[column * 3 + 2];
        }
    }
    for (let row = 0; row < 3; row++) {
        result[9 + row] = outer[row] * inner[9] + outer[3 + row] * inner[10] + outer[6 + row] * inner[11] + outer[9 + row];
    }
    return result;
}

const hullStations = [
    { z: 9.0, halfWidth: 0.0, height: 0.55 },
    { z: 7.6, halfWidth: 0.85, height: 1.15 },
    { z: 5.6, halfWidth: 1.55, height: 1.85 },
    { z: 3.4, halfWidth: 2.05, height: 2.45 },
    { z: 0.6, halfWidth: 2.3, height: 2.8 },
    { z: -1.1, halfWidth: 2.33, height: 2.89 },
    { z: -1.5, halfWidth: 2.335, height: 2.91 },
    { z: -2.4, halfWidth: 2.35, height: 2.95 },
    { z: -5.0, halfWidth: 2.2, height: 2.85 },
    { z: -7.0, halfWidth: 2.0, height: 2.6 },
];

const hullProfile = [
    [-0.72, 0], [-0.95, 0.17], [-1.0, 0.36], [-0.9, 0.6], [-0.66, 0.8], [-0.34, 0.95], [0, 1.0],
    [0.34, 0.95], [0.66, 0.8], [0.9, 0.6], [1.0, 0.36], [0.95, 0.17], [0.72, 0],
];
const hullProfileLastIndex = hullProfile.length - 1;

function hullRing(station) {
    return hullProfile.map(([across, up]) => [across * station.halfWidth, up * station.height, station.z]);
}

function hullEdgeSlot(edge, stationZ) {
    const fromSide = Math.min(edge, hullProfileLastIndex - 1 - edge);
    if (fromSide === 0) {
        return LANDER_SLOT_BELLY;
    }
    if (fromSide === 1) {
        return LANDER_SLOT_CHARCOAL;
    }
    if (fromSide === 3 && stationZ > 3.0 && stationZ < 6.8) {
        return LANDER_SLOT_GLASS;
    }
    if (fromSide >= 4 && stationZ < -1.1 && stationZ > -1.5) {
        return LANDER_SLOT_SIGNAL;
    }
    return LANDER_SLOT_HULL;
}

function buildHull() {
    const part = new Part("hull");
    const rings = hullStations.map(hullRing);
    for (let station = 0; station < rings.length - 1; station++) {
        const front = rings[station];
        const back = rings[station + 1];
        const stationZ = (hullStations[station].z + hullStations[station + 1].z) / 2;
        for (let edge = 0; edge < hullProfileLastIndex; edge++) {
            part.quad(front[edge], front[edge + 1], back[edge + 1], back[edge], hullEdgeSlot(edge, stationZ));
        }
        part.quad(front[hullProfileLastIndex], front[0], back[0], back[hullProfileLastIndex], LANDER_SLOT_BELLY);
    }
    const tail = rings[rings.length - 1];
    const tailCentre = [0, hullStations[hullStations.length - 1].height * 0.45, hullStations[hullStations.length - 1].z];
    for (let edge = 0; edge < hullProfile.length; edge++) {
        part.triangle(tail[edge], tail[(edge + 1) % hullProfile.length], tailCentre, LANDER_SLOT_DARK);
    }
    return part;
}

function buildRearModule() {
    const part = new Part("rearModule");
    const frontZ = landerDimensions.hullTailZ + 0.05;
    const backZ = landerDimensions.rearModuleTailZ;
    const profile = (z, scale) => [
        [-1.15 * scale, 0.25, z],
        [-1.45 * scale, 0.9, z],
        [-1.0 * scale, 1.75, z],
        [1.0 * scale, 1.75, z],
        [1.45 * scale, 0.9, z],
        [1.15 * scale, 0.25, z],
    ];
    const front = profile(frontZ, 1);
    const back = profile(backZ, 0.88);
    for (let edge = 0; edge < 6; edge++) {
        const next = (edge + 1) % 6;
        const slot = edge === 5 || edge === 0 ? LANDER_SLOT_BELLY : edge === 1 || edge === 4 ? LANDER_SLOT_CHARCOAL : LANDER_SLOT_HULL;
        part.quad(front[edge], front[next], back[next], back[edge], slot);
    }
    for (let edge = 1; edge < 5; edge++) {
        part.triangle(back[0], back[edge + 1], back[edge], LANDER_SLOT_DARK);
    }
    const bellSides = 14;
    const bellCentreY = 0.92;
    for (const offsetX of [-0.6, 0.6]) {
        const bellRing = (radius, z) => Array.from({ length: bellSides }, (unused, side) => {
            const angle = (side / bellSides) * Math.PI * 2;
            return [offsetX + Math.cos(angle) * radius, bellCentreY + Math.sin(angle) * radius, z];
        });
        const throat = bellRing(0.24, backZ + 0.02);
        const mouth = bellRing(0.4, backZ - 0.55);
        const lip = bellRing(0.43, backZ - 0.58);
        const deep = bellRing(0.2, backZ + 0.3);
        for (let side = 0; side < bellSides; side++) {
            const next = (side + 1) % bellSides;
            part.quad(throat[side], throat[next], mouth[next], mouth[side], LANDER_SLOT_METAL);
            part.quad(mouth[side], mouth[next], lip[next], lip[side], LANDER_SLOT_SIGNAL);
            part.quad(deep[side], deep[next], throat[next], throat[side], LANDER_SLOT_DARK);
        }
        for (let side = 1; side < bellSides - 1; side++) {
            part.triangle(deep[0], deep[side + 1], deep[side], LANDER_SLOT_DARK);
        }
    }
    return part;
}

function buildWing(side) {
    const part = new Part(side < 0 ? "wingLeft" : "wingRight");
    const rootY = 0.95;
    const rootLeading = [side * 2.2, rootY, 1.6];
    const rootTrailing = [side * 2.25, rootY, -6.2];
    const tipLeading = [side * 6.3, rootY + 0.25, -4.0];
    const tipTrailing = [side * 6.4, rootY + 0.22, -6.5];
    const rootThickness = 0.32;
    const tipThickness = 0.08;
    const top = [rootLeading, rootTrailing, tipTrailing, tipLeading].map(([x, y, z], index) => [x, y + (index < 2 ? rootThickness : tipThickness) * 0.5, z]);
    const bottom = [rootLeading, rootTrailing, tipTrailing, tipLeading].map(([x, y, z], index) => [x, y - (index < 2 ? rootThickness : tipThickness) * 0.5, z]);
    if (side > 0) {
        part.quad(top[0], top[3], top[2], top[1], LANDER_SLOT_HULL);
        part.quad(bottom[0], bottom[1], bottom[2], bottom[3], LANDER_SLOT_BELLY);
    } else {
        part.quad(top[0], top[1], top[2], top[3], LANDER_SLOT_HULL);
        part.quad(bottom[0], bottom[3], bottom[2], bottom[1], LANDER_SLOT_BELLY);
    }
    for (let edge = 0; edge < 4; edge++) {
        const next = (edge + 1) % 4;
        const edgeSlot = edge === 0 ? LANDER_SLOT_CHARCOAL : edge === 2 ? LANDER_SLOT_SIGNAL : edge === 3 ? LANDER_SLOT_CHARCOAL : LANDER_SLOT_HULL;
        part.quad(top[edge], bottom[edge], bottom[next], top[next], edgeSlot);
    }
    return part;
}

function buildFin(side) {
    const part = new Part(side < 0 ? "finLeft" : "finRight");
    const cant = (28 * Math.PI) / 180;
    const height = 2.1;
    const baseX = side * 0.95;
    const baseY = 2.55;
    const tipX = baseX + side * Math.sin(cant) * height;
    const tipY = baseY + Math.cos(cant) * height;
    const thickness = 0.12;
    const outline = [[baseX, baseY, -4.4], [baseX, baseY, -7.0], [tipX, tipY, -7.7], [tipX, tipY, -6.5]];
    const normalX = Math.cos(cant) * side;
    const normalY = -Math.sin(cant);
    const outer = outline.map(([x, y, z]) => [x + normalX * thickness * 0.5, y + normalY * thickness * 0.5, z]);
    const inner = outline.map(([x, y, z]) => [x - normalX * thickness * 0.5, y - normalY * thickness * 0.5, z]);
    if (side > 0) {
        part.quad(outer[0], outer[1], outer[2], outer[3], LANDER_SLOT_HULL);
        part.quad(inner[0], inner[3], inner[2], inner[1], LANDER_SLOT_HULL);
    } else {
        part.quad(outer[0], outer[3], outer[2], outer[1], LANDER_SLOT_HULL);
        part.quad(inner[0], inner[1], inner[2], inner[3], LANDER_SLOT_HULL);
    }
    for (let edge = 0; edge < 4; edge++) {
        const next = (edge + 1) % 4;
        part.quad(outer[edge], inner[edge], inner[next], outer[next], edge === 2 ? LANDER_SLOT_SIGNAL : edge === 3 ? LANDER_SLOT_CHARCOAL : LANDER_SLOT_HULL);
    }
    return part;
}

function boxPart(name, centre, halfSize, slot) {
    const part = new Part(name);
    const [cx, cy, cz] = centre;
    const [hx, hy, hz] = halfSize;
    const corner = (sx, sy, sz) => [cx + sx * hx, cy + sy * hy, cz + sz * hz];
    const faces = [
        [corner(-1, -1, 1), corner(1, -1, 1), corner(1, 1, 1), corner(-1, 1, 1)],
        [corner(1, -1, -1), corner(-1, -1, -1), corner(-1, 1, -1), corner(1, 1, -1)],
        [corner(1, -1, 1), corner(1, -1, -1), corner(1, 1, -1), corner(1, 1, 1)],
        [corner(-1, -1, -1), corner(-1, -1, 1), corner(-1, 1, 1), corner(-1, 1, -1)],
        [corner(-1, 1, 1), corner(1, 1, 1), corner(1, 1, -1), corner(-1, 1, -1)],
        [corner(-1, -1, -1), corner(1, -1, -1), corner(1, -1, 1), corner(-1, -1, 1)],
    ];
    for (const [a, b, c, d] of faces) {
        part.quad(a, b, c, d, slot);
    }
    part.exactBox = true;
    return part;
}

function buildLegs() {
    const parts = [];
    const length = landerDimensions.legLengthMetres;
    for (const [x, z] of [[-1.7, 3.6], [1.7, 3.6], [-1.9, -4.6], [1.9, -4.6]]) {
        parts.push(boxPart("leg", [x, -length / 2 + 0.05, z], [0.09, length / 2, 0.09], LANDER_SLOT_METAL));
        parts.push(boxPart("footPad", [x, -length + 0.04, z], [0.32, 0.04, 0.32], LANDER_SLOT_METAL));
    }
    return parts;
}

function buildTornPlate(random, centre, size) {
    const part = new Part("tornPlate");
    const corners = [];
    for (let corner = 0; corner < 5; corner++) {
        const angle = (corner / 5) * Math.PI * 2 + random() * 0.6;
        const radius = size * (0.6 + 0.5 * random());
        corners.push([centre[0] + Math.cos(angle) * radius, centre[1] + (random() - 0.3) * size * 0.5, centre[2] + Math.sin(angle) * radius]);
    }
    for (let corner = 1; corner < 4; corner++) {
        part.triangle(corners[0], corners[corner], corners[corner + 1], LANDER_SLOT_TORN);
        part.triangle(corners[0], corners[corner + 1], corners[corner], LANDER_SLOT_TORN);
    }
    return part;
}

function debrisPiece(random, slot) {
    const part = new Part("debris");
    const halfX = 0.3 + random() * 0.9;
    const halfY = 0.05 + random() * 0.25;
    const halfZ = 0.3 + random() * 1.1;
    const skew = (random() - 0.5) * 0.4;
    const corner = (sx, sy, sz) => [sx * halfX + sz * skew, sy * halfY * (1 + 0.3 * sx * sz), sz * halfZ];
    const faces = [
        [corner(-1, -1, 1), corner(1, -1, 1), corner(1, 1, 1), corner(-1, 1, 1)],
        [corner(1, -1, -1), corner(-1, -1, -1), corner(-1, 1, -1), corner(1, 1, -1)],
        [corner(1, -1, 1), corner(1, -1, -1), corner(1, 1, -1), corner(1, 1, 1)],
        [corner(-1, -1, -1), corner(-1, -1, 1), corner(-1, 1, 1), corner(-1, 1, -1)],
        [corner(-1, 1, 1), corner(1, 1, 1), corner(1, 1, -1), corner(-1, 1, -1)],
        [corner(-1, -1, -1), corner(1, -1, -1), corner(1, -1, 1), corner(-1, -1, 1)],
    ];
    faces.forEach(([a, b, c, d], faceIndex) => {
        part.quad(a, b, c, d, faceIndex === 4 ? slot : LANDER_SLOT_BELLY);
    });
    return part;
}

function placed(part, transform) {
    return { part: part.transformed(transform), proxy: part.bounds(), transform, proxyIsExact: Boolean(part.exactBox) };
}

function placedAround(part, yawRadians, pitchRadians, rollRadians, centreX, centreY, centreZ) {
    const { minimum, maximum } = part.bounds();
    const ownCentre = [0, 1, 2].map((axis) => (minimum[axis] + maximum[axis]) / 2);
    const transform = composeTransforms(rotationTranslation(yawRadians, pitchRadians, rollRadians, centreX, centreY, centreZ), rotationTranslation(0, 0, 0, -ownCentre[0], -ownCentre[1], -ownCentre[2]));
    return placed(part, transform);
}

export function buildLanderStates({ seed = 7 } = {}) {
    const hull = buildHull();
    const rearModule = buildRearModule();
    const wingLeft = buildWing(-1);
    const wingRight = buildWing(1);
    const finLeft = buildFin(-1);
    const finRight = buildFin(1);
    const legs = buildLegs();
    const identity = rotationTranslation(0, 0, 0, 0, 0, 0);
    const hullNose = hull.filterTriangles((centroid) => centroid[2] > 2.0, "hullNose");
    const hullMiddle = hull.filterTriangles((centroid) => centroid[2] <= 2.0 && centroid[2] > -3.2, "hullMiddle");
    const hullRear = hull.filterTriangles((centroid) => centroid[2] <= -3.2, "hullRear");
    const random = createRandom(seed);
    const states = [];
    states.push({
        name: "intact",
        restingHeightMetres: landerDimensions.bellyHeightAboveWaterMetres,
        pieces: [hullNose, hullMiddle, hullRear, rearModule, wingLeft, wingRight, finLeft, finRight, ...legs].map((part) => placed(part, identity)),
    });
    const bentFinLeft = finLeft.transformed(composeTransforms(rotationTranslation(0, 0, (-34 * Math.PI) / 180, -0.95, 2.55, 0), rotationTranslation(0, 0, 0, 0.95, -2.55, 0)));
    const tornPlate = buildTornPlate(random, [0.9, 2.95, -1.0], 0.9);
    states.push({
        name: "seventy percent",
        restingHeightMetres: -0.05,
        tilt: { pitchRadians: (5 * Math.PI) / 180, rollRadians: (-7 * Math.PI) / 180 },
        pieces: [
            hullNose.dented(random, 5, 0.12, 1.2),
            hullMiddle.dented(random, 6, 0.16, 1.4).filterTriangles((centroid) => !(centroid[0] > 0.2 && centroid[1] > 2.3 && centroid[2] < 0.2 && centroid[2] > -2.2), "hullMiddleTorn"),
            hullRear.dented(random, 4, 0.12, 1.2),
            rearModule.dented(random, 2, 0.1, 0.8),
            wingLeft.dented(random, 2, 0.08, 1.0),
            wingRight,
            bentFinLeft,
            finRight,
            tornPlate,
        ].map((part) => placed(part, identity)),
    });
    states.push({
        name: "forty percent",
        restingHeightMetres: -0.22,
        tilt: { pitchRadians: (-3 * Math.PI) / 180, rollRadians: (-16 * Math.PI) / 180 },
        pieces: [
            placed(hullNose.dented(random, 7, 0.22, 1.4), identity),
            placed(hullMiddle.dented(random, 8, 0.26, 1.6), identity),
            placed(hullRear.dented(random, 5, 0.2, 1.2), rotationTranslation((6 * Math.PI) / 180, 0, (4 * Math.PI) / 180, 0.4, -0.1, -0.6)),
            placedAround(rearModule.dented(random, 4, 0.18, 0.9), (14 * Math.PI) / 180, (-6 * Math.PI) / 180, (9 * Math.PI) / 180, 0.9, 0.75, -9.6),
            placed(wingRight.dented(random, 3, 0.12, 1.2), rotationTranslation(0, 0, (12 * Math.PI) / 180, 0, -0.4, 0)),
            placed(finRight, identity),
            placed(buildTornPlate(random, [-2.0, 1.2, 0.0], 1.2), identity),
            placed(buildTornPlate(random, [1.6, 2.6, -2.4], 0.9), identity),
        ],
    });
    const wreckagePieces = [
        placedAround(hullNose.dented(random, 6, 0.3, 1.2), 0.5, 0.18, -0.6, 1.5, 0.35, 3.0),
        placedAround(hullRear.dented(random, 5, 0.3, 1.2), -0.7, -0.12, 0.9, -2.5, 0.2, -3.5),
        placedAround(rearModule.dented(random, 4, 0.2, 0.9), 1.9, 0.3, 1.2, 4.5, 0.25, -7.5),
        placedAround(wingRight.dented(random, 3, 0.15, 1.2), 2.6, 0.08, 0.15, 6.0, -0.05, 4.0),
        placedAround(finRight, 0.9, 1.3, 0.2, -6.5, 0.05, 1.5),
        placedAround(finLeft, -1.2, 1.1, -0.3, 3.0, 0.0, 8.5),
    ];
    for (let piece = 0; piece < 10; piece++) {
        const angle = random() * Math.PI * 2;
        const distance = 3 + random() * 11;
        wreckagePieces.push(placedAround(debrisPiece(random, random() < 0.6 ? LANDER_SLOT_HULL : LANDER_SLOT_TORN), random() * 6.28, (random() - 0.5) * 0.5, (random() - 0.5) * 0.6, Math.cos(angle) * distance, -0.05 + random() * 0.12, Math.sin(angle) * distance));
    }
    states.push({ name: "wreckage", restingHeightMetres: 0, pieces: wreckagePieces });
    states.push({ name: "gone", restingHeightMetres: 0, pieces: [] });
    return states;
}

export function flattenLanderState(state) {
    let triangleCount = 0;
    for (const piece of state.pieces) {
        triangleCount += piece.part.triangleCount;
    }
    const positions = new Float32Array(triangleCount * 9);
    const normals = new Float32Array(triangleCount * 9);
    const slots = new Float32Array(triangleCount * 3);
    const surfaceCoordinates = new Float32Array(triangleCount * 6);
    let triangle = 0;
    for (const piece of state.pieces) {
        const source = piece.part.positions;
        for (let local = 0; local < piece.part.triangleCount; local++) {
            const offset = local * 9;
            const ax = source[offset];
            const ay = source[offset + 1];
            const az = source[offset + 2];
            const bx = source[offset + 3];
            const by = source[offset + 4];
            const bz = source[offset + 5];
            const cx = source[offset + 6];
            const cy = source[offset + 7];
            const cz = source[offset + 8];
            const ux = bx - ax;
            const uy = by - ay;
            const uz = bz - az;
            const vx = cx - ax;
            const vy = cy - ay;
            const vz = cz - az;
            let normalX = uy * vz - uz * vy;
            let normalY = uz * vx - ux * vz;
            let normalZ = ux * vy - uy * vx;
            const length = Math.hypot(normalX, normalY, normalZ) || 1;
            normalX /= length;
            normalY /= length;
            normalZ /= length;
            for (let corner = 0; corner < 3; corner++) {
                const target = triangle * 9 + corner * 3;
                positions[target] = source[offset + corner * 3];
                positions[target + 1] = source[offset + corner * 3 + 1];
                positions[target + 2] = source[offset + corner * 3 + 2];
                normals[target] = normalX;
                normals[target + 1] = normalY;
                normals[target + 2] = normalZ;
                slots[triangle * 3 + corner] = piece.part.slots[local];
                surfaceCoordinates[triangle * 6 + corner * 2] = source[offset + corner * 3] + source[offset + corner * 3 + 1] * 0.37;
                surfaceCoordinates[triangle * 6 + corner * 2 + 1] = source[offset + corner * 3 + 2] + source[offset + corner * 3 + 1] * 0.61;
            }
            triangle++;
        }
    }
    const indices = new Uint32Array(triangleCount * 3);
    for (let index = 0; index < indices.length; index++) {
        indices[index] = index;
    }
    return { positions, normals, slots, surfaceCoordinates, indices, triangleCount };
}

export function landerProxyBoxes(state) {
    const boxes = [];
    for (const piece of state.pieces) {
        const { minimum, maximum } = piece.proxy;
        const transform = piece.transform;
        const localCentre = [0, 1, 2].map((axis) => (minimum[axis] + maximum[axis]) / 2);
        const halfSize = [0, 1, 2].map((axis) => Math.max((maximum[axis] - minimum[axis]) / 2, 0.03));
        const centre = [
            transform[0] * localCentre[0] + transform[3] * localCentre[1] + transform[6] * localCentre[2] + transform[9],
            transform[1] * localCentre[0] + transform[4] * localCentre[1] + transform[7] * localCentre[2] + transform[10],
            transform[2] * localCentre[0] + transform[5] * localCentre[1] + transform[8] * localCentre[2] + transform[11],
        ];
        const sortedHalves = halfSize.slice().sort((first, second) => first - second);
        boxes.push({ name: piece.part.name, showsThroughWater: piece.proxyIsExact, poleLike: sortedHalves[1] <= 0.15, centre, halfSize, axes: [[transform[0], transform[1], transform[2]], [transform[3], transform[4], transform[5]], [transform[6], transform[7], transform[8]]] });
    }
    return boxes;
}
