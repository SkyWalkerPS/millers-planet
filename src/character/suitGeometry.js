/*
 * Derived from snowflow_demo by Maksymilian Dendura (Noniv): https://github.com/Noniv/snowflow_demo
 * Copyright (c) 2026 Maksymilian Dendura. MIT License; full text in LICENSE.
 */

import {
    BONE_CHEST, BONE_ELBOW_LEFT, BONE_ELBOW_RIGHT, BONE_FOOT_LEFT, BONE_FOOT_RIGHT, BONE_FOREARM_LEFT, BONE_FOREARM_RIGHT,
    BONE_HAND_LEFT, BONE_HAND_RIGHT, BONE_HELMET, BONE_KNEE_LEFT, BONE_KNEE_RIGHT, BONE_PELVIS, BONE_SHIN_LEFT, BONE_SHIN_RIGHT,
    BONE_SPINE, BONE_THIGH_LEFT, BONE_THIGH_RIGHT, BONE_UPPER_ARM_LEFT, BONE_UPPER_ARM_RIGHT, bindJointPosition, suitProportions,
} from "./suitSkeleton.js";

export const SLOT_SUIT_FABRIC = 0;
export const SLOT_ACCENT_FABRIC = 1;
export const SLOT_HARD_SHELL = 2;
export const SLOT_RUBBER = 3;
export const SLOT_METAL = 4;
export const SLOT_BELLOWS = 5;
export const SLOT_PATCH = 6;

const segmentsForLimbs = 20;
const segmentsForTorso = 28;

class MeshBuilder {
    constructor() {
        this.positions = [];
        this.normals = [];
        this.uvs = [];
        this.aux = [];
        this.boneIndices = [];
        this.boneWeights = [];
        this.indices = [];
        this.explicitNormalVertices = new Set();
    }

    vertex(x, y, z, u, v, slot, occlusion, firstBone, firstWeight, secondBone = 0, secondWeight = 0) {
        this.positions.push(x, y, z);
        this.normals.push(0, 0, 0);
        this.uvs.push(u, v);
        this.aux.push(slot, occlusion);
        this.boneIndices.push(firstBone, secondBone, 0, 0);
        this.boneWeights.push(firstWeight, secondWeight, 0, 0);
        return this.positions.length / 3 - 1;
    }

    setNormal(vertexIndex, x, y, z) {
        this.normals[vertexIndex * 3] = x;
        this.normals[vertexIndex * 3 + 1] = y;
        this.normals[vertexIndex * 3 + 2] = z;
        this.explicitNormalVertices.add(vertexIndex);
    }

    triangle(a, b, c) {
        this.indices.push(a, b, c);
    }

    quad(a, b, c, d) {
        this.indices.push(a, b, c, a, c, d);
    }

    finish() {
        const positions = new Float32Array(this.positions);
        const normals = new Float32Array(this.normals);
        const accumulated = new Float64Array(positions.length);
        const indices = this.indices;
        for (let index = 0; index < indices.length; index += 3) {
            const a = indices[index] * 3;
            const b = indices[index + 1] * 3;
            const c = indices[index + 2] * 3;
            const ux = positions[b] - positions[a];
            const uy = positions[b + 1] - positions[a + 1];
            const uz = positions[b + 2] - positions[a + 2];
            const vx = positions[c] - positions[a];
            const vy = positions[c + 1] - positions[a + 1];
            const vz = positions[c + 2] - positions[a + 2];
            const faceX = uy * vz - uz * vy;
            const faceY = uz * vx - ux * vz;
            const faceZ = ux * vy - uy * vx;
            for (const corner of [a, b, c]) {
                accumulated[corner] += faceX;
                accumulated[corner + 1] += faceY;
                accumulated[corner + 2] += faceZ;
            }
        }
        for (let vertex = 0; vertex < positions.length / 3; vertex++) {
            if (this.explicitNormalVertices.has(vertex)) {
                continue;
            }
            const offset = vertex * 3;
            const length = Math.hypot(accumulated[offset], accumulated[offset + 1], accumulated[offset + 2]) || 1;
            normals[offset] = accumulated[offset] / length;
            normals[offset + 1] = accumulated[offset + 1] / length;
            normals[offset + 2] = accumulated[offset + 2] / length;
        }
        return {
            positions,
            normals,
            uvs: new Float32Array(this.uvs),
            aux: new Float32Array(this.aux),
            boneIndices: new Float32Array(this.boneIndices),
            boneWeights: new Float32Array(this.boneWeights),
            indices: new Uint32Array(indices),
            vertexCount: positions.length / 3,
            triangleCount: indices.length / 3,
        };
    }
}

function signedPower(value, exponent) {
    return Math.sign(value) * Math.pow(Math.abs(value), exponent);
}

function ring(centreX, centreY, centreZ, radiusAcross, radiusDepth, occlusion, bones, exponent = 2) {
    return { centreX, centreY, centreZ, radiusAcross, radiusDepth, occlusion, bones, exponent };
}

function loft(builder, rings, slot, reference, segments, capStart, capEnd) {
    const count = rings.length;
    let previousRow = null;
    let firstRow = null;
    let distanceAlong = 0;
    for (let ringIndex = 0; ringIndex < count; ringIndex++) {
        const current = rings[ringIndex];
        const previous = rings[Math.max(0, ringIndex - 1)];
        const next = rings[Math.min(count - 1, ringIndex + 1)];
        let axisX = next.centreX - previous.centreX;
        let axisY = next.centreY - previous.centreY;
        let axisZ = next.centreZ - previous.centreZ;
        const axisLength = Math.hypot(axisX, axisY, axisZ) || 1;
        axisX /= axisLength;
        axisY /= axisLength;
        axisZ /= axisLength;
        let acrossX = axisY * reference[2] - axisZ * reference[1];
        let acrossY = axisZ * reference[0] - axisX * reference[2];
        let acrossZ = axisX * reference[1] - axisY * reference[0];
        const acrossLength = Math.hypot(acrossX, acrossY, acrossZ) || 1;
        acrossX /= acrossLength;
        acrossY /= acrossLength;
        acrossZ /= acrossLength;
        const depthX = axisY * acrossZ - axisZ * acrossY;
        const depthY = axisZ * acrossX - axisX * acrossZ;
        const depthZ = axisX * acrossY - axisY * acrossX;
        if (ringIndex > 0) {
            distanceAlong += Math.hypot(current.centreX - previous.centreX, current.centreY - previous.centreY, current.centreZ - previous.centreZ);
        }
        const circumference = Math.PI * (current.radiusAcross + current.radiusDepth);
        const exponent = 2 / current.exponent;
        const row = [];
        for (let segment = 0; segment < segments; segment++) {
            const angle = (segment / segments) * Math.PI * 2;
            const across = signedPower(Math.sin(angle), exponent) * current.radiusAcross;
            const depth = signedPower(Math.cos(angle), exponent) * current.radiusDepth;
            row.push(builder.vertex(
                current.centreX + acrossX * across + depthX * depth,
                current.centreY + acrossY * across + depthY * depth,
                current.centreZ + acrossZ * across + depthZ * depth,
                (segment / segments) * circumference, distanceAlong,
                slot, current.occlusion, current.bones[0], current.bones[1], current.bones[2] ?? 0, current.bones[3] ?? 0,
            ));
        }
        if (previousRow) {
            for (let segment = 0; segment < segments; segment++) {
                const nextSegment = (segment + 1) % segments;
                builder.quad(previousRow[segment], previousRow[nextSegment], row[nextSegment], row[segment]);
            }
        }
        if (ringIndex === 0) {
            firstRow = row;
        }
        previousRow = row;
    }
    if (capStart) {
        capRing(builder, rings[0], rings[1], firstRow, slot, segments, true);
    }
    if (capEnd) {
        capRing(builder, rings[count - 1], rings[count - 2], previousRow, slot, segments, false);
    }
}

function capRing(builder, capRingData, neighbour, row, slot, segments, isStart) {
    let axisX = capRingData.centreX - neighbour.centreX;
    let axisY = capRingData.centreY - neighbour.centreY;
    let axisZ = capRingData.centreZ - neighbour.centreZ;
    const axisLength = Math.hypot(axisX, axisY, axisZ) || 1;
    axisX /= axisLength;
    axisY /= axisLength;
    axisZ /= axisLength;
    const extension = Math.max(capRingData.radiusAcross, capRingData.radiusDepth) * 0.45;
    const centre = builder.vertex(
        capRingData.centreX + axisX * extension, capRingData.centreY + axisY * extension, capRingData.centreZ + axisZ * extension,
        0.5, 0.5, slot, capRingData.occlusion, capRingData.bones[0], capRingData.bones[1], capRingData.bones[2] ?? 0, capRingData.bones[3] ?? 0,
    );
    for (let segment = 0; segment < segments; segment++) {
        const nextSegment = (segment + 1) % segments;
        if (isStart) {
            builder.triangle(centre, row[nextSegment], row[segment]);
        } else {
            builder.triangle(centre, row[segment], row[nextSegment]);
        }
    }
}

function torsoBones(y) {
    const pelvisY = bindJointPosition(BONE_PELVIS)[1];
    const spineY = bindJointPosition(BONE_SPINE)[1];
    const chestY = bindJointPosition(BONE_CHEST)[1];
    if (y < spineY) {
        const t = Math.min(1, Math.max(0, (y - (pelvisY - 0.08)) / (spineY - pelvisY + 0.08)));
        return [BONE_PELVIS, 1 - t * 0.5, BONE_SPINE, t * 0.5];
    }
    if (y < chestY) {
        const t = (y - spineY) / (chestY - spineY);
        return [BONE_SPINE, 1 - t, BONE_CHEST, t];
    }
    return [BONE_CHEST, 1, 0, 0];
}

function segmentRings(start, end, startRadius, endRadius, steps, firstBone, secondBone, blendFrom, blendTo, occlusion, bellows) {
    const rings = [];
    for (let stepIndex = 0; stepIndex <= steps; stepIndex++) {
        const t = stepIndex / steps;
        const blend = Math.min(1, Math.max(0, (t - blendFrom) / Math.max(blendTo - blendFrom, 1e-6)));
        let radius = startRadius + (endRadius - startRadius) * t;
        if (bellows && t > bellows.from && t < bellows.to) {
            radius += bellows.amplitude * Math.cos(((t - bellows.from) / (bellows.to - bellows.from)) * Math.PI * 2 * bellows.ridges);
        }
        rings.push(ring(
            start[0] + (end[0] - start[0]) * t,
            start[1] + (end[1] - start[1]) * t,
            start[2] + (end[2] - start[2]) * t,
            radius, radius, occlusion, [firstBone, 1 - blend, secondBone, blend],
        ));
    }
    return rings;
}

function buildTorso(builder) {
    const table = [
        [0.86, 0.15, 0.125, 0.62],
        [0.9, 0.168, 0.138, 0.66],
        [0.98, 0.178, 0.142, 0.7],
        [1.06, 0.172, 0.139, 0.72],
        [1.15, 0.186, 0.148, 0.76],
        [1.25, 0.204, 0.157, 0.8],
        [1.35, 0.216, 0.161, 0.84],
        [1.43, 0.206, 0.153, 0.82],
        [1.48, 0.17, 0.135, 0.7],
        [1.505, 0.13, 0.12, 0.6],
    ];
    const rings = table.map(([y, across, depth, occlusion]) => ring(0, y, 0, across, depth, occlusion, torsoBones(y), 2.6));
    loft(builder, rings, SLOT_SUIT_FABRIC, [0, 0, 1], segmentsForTorso, true, false);
    const beltRings = [0.965, 0.99, 1.015].map((y, index) => ring(0, y, 0, 0.183 + (index === 1 ? 0.006 : 0), 0.147 + (index === 1 ? 0.006 : 0), 0.62, torsoBones(y), 2.6));
    loft(builder, beltRings, SLOT_ACCENT_FABRIC, [0, 0, 1], segmentsForTorso, false, false);
}

function buildNeckRing(builder) {
    const rings = [1.49, 1.5, 1.512, 1.522].map((y, index) => ring(0, y, 0.005, [0.14, 0.15, 0.15, 0.138][index], [0.13, 0.14, 0.14, 0.128][index], 0.7, [BONE_CHEST, 1, 0, 0]));
    loft(builder, rings, SLOT_METAL, [0, 0, 1], segmentsForTorso, false, false);
}

function buildHelmet(builder) {
    const [centreX, centreY, centreZ] = bindJointPosition(BONE_HELMET);
    const radius = 0.165;
    const rings = [];
    const polarSteps = 14;
    for (let stepIndex = 0; stepIndex <= polarSteps; stepIndex++) {
        const polar = 0.62 + (Math.PI - 0.62 - 0.03) * (stepIndex / polarSteps);
        const y = centreY - Math.cos(polar) * radius;
        const sectionRadius = Math.sin(polar) * radius;
        rings.push(ring(centreX, y, centreZ, sectionRadius, sectionRadius, 0.85, [BONE_HELMET, 1, 0, 0]));
    }
    loft(builder, rings, SLOT_HARD_SHELL, [0, 0, 1], segmentsForTorso, false, true);
}

function buildBackpack(builder) {
    const centreZ = -0.235;
    const table = [[0.98, 0.15, 0.06], [1.0, 0.185, 0.08], [1.06, 0.19, 0.085], [1.24, 0.19, 0.088], [1.42, 0.188, 0.085], [1.48, 0.18, 0.078], [1.5, 0.15, 0.06]];
    const rings = table.map(([y, across, depth]) => ring(0, y, centreZ, across, depth, 0.78, [BONE_CHEST, 1, 0, 0], 4.5));
    loft(builder, rings, SLOT_HARD_SHELL, [0, 0, 1], segmentsForTorso, true, true);
}

function buildChestUnit(builder) {
    const table = [[1.15, 0.085, 0.022], [1.16, 0.1, 0.035], [1.27, 0.1, 0.035], [1.28, 0.085, 0.022]];
    const rings = table.map(([y, across, depth]) => ring(0, y, 0.178, across, depth, 0.8, [BONE_CHEST, 1, 0, 0], 5));
    loft(builder, rings, SLOT_HARD_SHELL, [0, 0, 1], 20, true, true);
    const patchRings = [[1.355, 0.035], [1.365, 0.04], [1.375, 0.035]].map(([y, across]) => ring(0.11, y, 0.152, across, 0.012, 0.85, [BONE_CHEST, 1, 0, 0], 2));
    loft(builder, patchRings, SLOT_PATCH, [0, 0, 1], 16, true, true);
}

function buildArm(builder, side, upperBone, foreBone, handBone, elbowBone) {
    const shoulder = bindJointPosition(upperBone);
    const elbow = bindJointPosition(foreBone);
    const wrist = bindJointPosition(handBone);
    const bearingRings = [-0.02, 0.0, 0.03, 0.05].map((offset, index) => {
        const t = offset / suitProportions.upperArmLengthMetres;
        return ring(shoulder[0] + (elbow[0] - shoulder[0]) * t, shoulder[1] + (elbow[1] - shoulder[1]) * t, shoulder[2], [0.084, 0.095, 0.095, 0.086][index], [0.084, 0.095, 0.095, 0.086][index], 0.7, [BONE_CHEST, 1, 0, 0]);
    });
    loft(builder, bearingRings, SLOT_METAL, [0, 0, 1], segmentsForLimbs, false, false);
    const upper = segmentRings(shoulder, elbow, 0.078, 0.066, 8, upperBone, elbowBone, 0.72, 1.0, 0.62, { from: 0.74, to: 1.0, ridges: 2, amplitude: 0.006 });
    const fore = segmentRings(elbow, wrist, 0.066, 0.055, 7, elbowBone, foreBone, 0.0, 0.28, 0.66, { from: 0.0, to: 0.24, ridges: 1.5, amplitude: 0.006 });
    loft(builder, upper.concat(fore.slice(1)), SLOT_SUIT_FABRIC, [0, 0, 1], segmentsForLimbs, false, false);
    const direction = [(wrist[0] - elbow[0]) / suitProportions.forearmLengthMetres, (wrist[1] - elbow[1]) / suitProportions.forearmLengthMetres, (wrist[2] - elbow[2]) / suitProportions.forearmLengthMetres];
    const along = (distance) => [wrist[0] + direction[0] * distance, wrist[1] + direction[1] * distance, wrist[2] + direction[2] * distance];
    const wristRing = [[-0.015, 0.058], [0.0, 0.064], [0.015, 0.058]].map(([distance, radius]) => {
        const point = along(distance);
        return ring(point[0], point[1], point[2], radius, radius, 0.7, [handBone, 1, 0, 0]);
    });
    loft(builder, wristRing, SLOT_METAL, [0, 0, 1], segmentsForLimbs, false, false);
    const gloveTable = [[0.01, 0.05, 0.042], [0.05, 0.052, 0.036], [0.1, 0.05, 0.03], [0.14, 0.042, 0.026], [0.165, 0.03, 0.02]];
    const glove = gloveTable.map(([distance, across, depth]) => {
        const point = along(distance);
        return ring(point[0], point[1], point[2], across, depth, 0.55, [handBone, 1, 0, 0], 2.4);
    });
    loft(builder, glove, SLOT_RUBBER, [1, 0, 0], 16, false, true);
    const thumbBase = along(0.05);
    const thumb = [[0, 0.018], [0.035, 0.016], [0.06, 0.013]].map(([distance, radius]) => ring(thumbBase[0], thumbBase[1] - distance * 0.6, thumbBase[2] + 0.03 + distance * 0.5, radius, radius, 0.55, [handBone, 1, 0, 0]));
    loft(builder, thumb, SLOT_RUBBER, [1, 0, 0], 10, false, true);
}

function buildLeg(builder, side, thighBone, shinBone, footBone, kneeBone) {
    const hip = bindJointPosition(thighBone);
    const knee = bindJointPosition(shinBone);
    const ankle = bindJointPosition(footBone);
    const thighTop = [hip[0], hip[1] + 0.03, hip[2]];
    const thigh = segmentRings(thighTop, knee, 0.118, 0.094, 9, thighBone, kneeBone, 0.76, 1.0, 0.6, { from: 0.8, to: 1.0, ridges: 2, amplitude: 0.007 });
    const cuffY = 0.19;
    const shinEnd = [knee[0], cuffY, knee[2]];
    const shinSteps = 7;
    const shin = segmentRings(knee, shinEnd, 0.094, 0.082, shinSteps, kneeBone, shinBone, 0.0, 0.3, 0.6, { from: 0.0, to: 0.22, ridges: 1.5, amplitude: 0.007 });
    loft(builder, thigh.concat(shin.slice(1)), SLOT_SUIT_FABRIC, [0, 0, 1], segmentsForLimbs, true, false);
    const kneePad = [[0.04, 0.03], [0.02, 0.05], [0.0, 0.055], [-0.03, 0.045], [-0.05, 0.03]].map(([offset, radius]) => ring(knee[0], knee[1] + offset, knee[2] + 0.085, radius, 0.014, 0.8, [kneeBone, 1, 0, 0], 2.4));
    loft(builder, kneePad, SLOT_HARD_SHELL, [0, 0, 1], 14, true, true);
    const bootShaft = [[0.21, 0.086, 0.088, shinBone, 0.6], [0.19, 0.09, 0.094, shinBone, 0.4], [0.16, 0.084, 0.09, footBone, 0.2], [0.12, 0.078, 0.086, footBone, 0.0]].map(([y, across, depth, bone, shinWeight]) => {
        const bones = bone === shinBone ? [shinBone, shinWeight, footBone, 1 - shinWeight] : [footBone, 1, 0, 0];
        return ring(ankle[0], y, ankle[2] - 0.01, across, depth, 0.5, bones, 2.4);
    });
    loft(builder, bootShaft, SLOT_RUBBER, [0, 0, 1], segmentsForLimbs, false, false);
    const footTable = [[-0.105, 0.06, 0.05, 0.04], [-0.095, 0.07, 0.062, 0.055], [-0.04, 0.085, 0.072, 0.07], [0.04, 0.08, 0.07, 0.058], [0.12, 0.06, 0.066, 0.042], [0.19, 0.045, 0.056, 0.03], [0.222, 0.04, 0.04, 0.02]];
    const footRings = footTable.map(([z, y, across, height]) => ring(ankle[0], y, ankle[2] + z, across, height, 0.45, [footBone, 1, 0, 0], 3));
    loft(builder, footRings, SLOT_RUBBER, [0, 1, 0], segmentsForLimbs, true, true);
    const soleTable = [[-0.105, 0.064], [-0.095, 0.072], [0.18, 0.068], [0.225, 0.045]];
    const sole = soleTable.map(([z, across]) => ring(ankle[0], 0.012, ankle[2] + z, across, 0.012, 0.35, [footBone, 1, 0, 0], 4));
    loft(builder, sole, SLOT_RUBBER, [0, 1, 0], 16, true, true);
}

export function buildHelmetShellGeometry() {
    const builder = new MeshBuilder();
    buildHelmet(builder);
    return builder.finish();
}

export function buildSuitGeometry() {
    const builder = new MeshBuilder();
    buildTorso(builder);
    buildNeckRing(builder);
    buildBackpack(builder);
    buildChestUnit(builder);
    buildArm(builder, -1, BONE_UPPER_ARM_LEFT, BONE_FOREARM_LEFT, BONE_HAND_LEFT, BONE_ELBOW_LEFT);
    buildArm(builder, 1, BONE_UPPER_ARM_RIGHT, BONE_FOREARM_RIGHT, BONE_HAND_RIGHT, BONE_ELBOW_RIGHT);
    buildLeg(builder, -1, BONE_THIGH_LEFT, BONE_SHIN_LEFT, BONE_FOOT_LEFT, BONE_KNEE_LEFT);
    buildLeg(builder, 1, BONE_THIGH_RIGHT, BONE_SHIN_RIGHT, BONE_FOOT_RIGHT, BONE_KNEE_RIGHT);
    return builder.finish();
}

export const visorShape = {
    radiusMetres: 0.171,
    azimuthHalfRangeRadians: (66 * Math.PI) / 180,
    elevationLowRadians: (-30 * Math.PI) / 180,
    elevationHighRadians: (38 * Math.PI) / 180,
};

export function buildVisorGeometry() {
    const builder = new MeshBuilder();
    const [centreX, centreY, centreZ] = bindJointPosition(BONE_HELMET);
    const columns = 24;
    const rows = 16;
    const grid = [];
    for (let row = 0; row <= rows; row++) {
        const elevation = visorShape.elevationLowRadians + (visorShape.elevationHighRadians - visorShape.elevationLowRadians) * (row / rows);
        const rowVertices = [];
        for (let column = 0; column <= columns; column++) {
            const azimuth = -visorShape.azimuthHalfRangeRadians + 2 * visorShape.azimuthHalfRangeRadians * (column / columns);
            const normalX = Math.sin(azimuth) * Math.cos(elevation);
            const normalY = Math.sin(elevation);
            const normalZ = Math.cos(azimuth) * Math.cos(elevation);
            const vertex = builder.vertex(
                centreX + normalX * visorShape.radiusMetres, centreY + normalY * visorShape.radiusMetres, centreZ + normalZ * visorShape.radiusMetres,
                column / columns, row / rows, SLOT_HARD_SHELL, 1, BONE_HELMET, 1,
            );
            builder.setNormal(vertex, normalX, normalY, normalZ);
            rowVertices.push(vertex);
        }
        grid.push(rowVertices);
    }
    for (let row = 0; row < rows; row++) {
        for (let column = 0; column < columns; column++) {
            builder.quad(grid[row][column], grid[row + 1][column], grid[row + 1][column + 1], grid[row][column + 1]);
        }
    }
    return builder.finish();
}
