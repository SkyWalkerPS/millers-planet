/*
 * Derived from snowflow_demo by Maksymilian Dendura (Noniv): https://github.com/Noniv/snowflow_demo
 * Copyright (c) 2026 Maksymilian Dendura. MIT License; full text in LICENSE.
 */

import { invertRigid, setFrameFromDirection } from "./rigMath.js";

export const BONE_PELVIS = 0;
export const BONE_SPINE = 1;
export const BONE_CHEST = 2;
export const BONE_NECK = 3;
export const BONE_HEAD = 4;
export const BONE_HELMET = 5;
export const BONE_UPPER_ARM_LEFT = 6;
export const BONE_FOREARM_LEFT = 7;
export const BONE_HAND_LEFT = 8;
export const BONE_UPPER_ARM_RIGHT = 9;
export const BONE_FOREARM_RIGHT = 10;
export const BONE_HAND_RIGHT = 11;
export const BONE_THIGH_LEFT = 12;
export const BONE_SHIN_LEFT = 13;
export const BONE_FOOT_LEFT = 14;
export const BONE_THIGH_RIGHT = 15;
export const BONE_SHIN_RIGHT = 16;
export const BONE_FOOT_RIGHT = 17;
export const BONE_KNEE_LEFT = 18;
export const BONE_KNEE_RIGHT = 19;
export const BONE_ELBOW_LEFT = 20;
export const BONE_ELBOW_RIGHT = 21;
export const BONE_COUNT = 22;

export const suitProportions = {
    thighLengthMetres: 0.45,
    shinLengthMetres: 0.42,
    upperArmLengthMetres: 0.28,
    forearmLengthMetres: 0.26,
    ankleHeightMetres: 0.1,
    hipHalfWidthMetres: 0.115,
    hipDropBelowPelvisMetres: 0.03,
    shoulderHalfWidthMetres: 0.215,
    shoulderRiseAboveChestMetres: 0.14,
    pelvisAboveSpineMetres: 0.11,
    chestAbovePelvisMetres: 0.3,
    neckAboveChestMetres: 0.2,
    headAboveNeckMetres: 0.12,
    helmetCentreAboveNeckMetres: 0.16,
    helmetCentreForwardMetres: 0.01,
    eyeForwardOfHeadMetres: 0.07,
    eyeAboveHeadMetres: 0.08,
    soleBelowAnkleMetres: 0.1,
    heelBehindAnkleMetres: 0.09,
    toeAheadOfAnkleMetres: 0.21,
    ballAheadOfAnkleMetres: 0.13,
};

const standingHipHeight = suitProportions.thighLengthMetres + suitProportions.shinLengthMetres + suitProportions.ankleHeightMetres;
export const standingPelvisHeightMetres = standingHipHeight + suitProportions.hipDropBelowPelvisMetres;

function bindTable() {
    const proportions = suitProportions;
    const pelvisY = standingPelvisHeightMetres;
    const chestY = pelvisY + proportions.chestAbovePelvisMetres;
    const neckY = chestY + proportions.neckAboveChestMetres;
    const hipY = pelvisY - proportions.hipDropBelowPelvisMetres;
    const kneeY = hipY - proportions.thighLengthMetres;
    const ankleY = kneeY - proportions.shinLengthMetres;
    const shoulderY = chestY + proportions.shoulderRiseAboveChestMetres;
    const armOutward = 0.2;
    const armDirectionLength = Math.hypot(armOutward, 1);
    const armDirectionX = armOutward / armDirectionLength;
    const armDirectionY = -1 / armDirectionLength;
    const elbowOffsetX = armDirectionX * proportions.upperArmLengthMetres;
    const elbowOffsetY = armDirectionY * proportions.upperArmLengthMetres;
    const handOffsetX = armDirectionX * proportions.forearmLengthMetres;
    const handOffsetY = armDirectionY * proportions.forearmLengthMetres;
    const shoulderX = proportions.shoulderHalfWidthMetres;
    const hipX = proportions.hipHalfWidthMetres;
    const table = [];
    table[BONE_PELVIS] = [0, pelvisY, 0, 0, 1, 0, 0, 0, 1];
    table[BONE_SPINE] = [0, pelvisY + proportions.pelvisAboveSpineMetres, 0, 0, 1, 0, 0, 0, 1];
    table[BONE_CHEST] = [0, chestY, 0, 0, 1, 0, 0, 0, 1];
    table[BONE_NECK] = [0, neckY, 0, 0, 1, 0, 0, 0, 1];
    table[BONE_HEAD] = [0, neckY + proportions.headAboveNeckMetres, 0, 0, 1, 0, 0, 0, 1];
    table[BONE_HELMET] = [0, neckY + proportions.helmetCentreAboveNeckMetres, proportions.helmetCentreForwardMetres, 0, 1, 0, 0, 0, 1];
    for (const [side, upper, fore, hand, elbow] of [[-1, BONE_UPPER_ARM_LEFT, BONE_FOREARM_LEFT, BONE_HAND_LEFT, BONE_ELBOW_LEFT], [1, BONE_UPPER_ARM_RIGHT, BONE_FOREARM_RIGHT, BONE_HAND_RIGHT, BONE_ELBOW_RIGHT]]) {
        const elbowX = side * (shoulderX + elbowOffsetX);
        const elbowY = shoulderY + elbowOffsetY;
        table[upper] = [side * shoulderX, shoulderY, 0, side * armDirectionX, armDirectionY, 0, 0, 0, 1];
        table[fore] = [elbowX, elbowY, 0, side * armDirectionX, armDirectionY, 0, 0, 0, 1];
        table[hand] = [elbowX + side * handOffsetX, elbowY + handOffsetY, 0, side * armDirectionX, armDirectionY, 0, 0, 0, 1];
        table[elbow] = [elbowX, elbowY, 0, side * armDirectionX, armDirectionY, 0, 0, 0, 1];
    }
    for (const [side, thigh, shin, foot, knee] of [[-1, BONE_THIGH_LEFT, BONE_SHIN_LEFT, BONE_FOOT_LEFT, BONE_KNEE_LEFT], [1, BONE_THIGH_RIGHT, BONE_SHIN_RIGHT, BONE_FOOT_RIGHT, BONE_KNEE_RIGHT]]) {
        table[thigh] = [side * hipX, hipY, 0, 0, -1, 0, 0, 0, 1];
        table[shin] = [side * hipX, kneeY, 0, 0, -1, 0, 0, 0, 1];
        table[foot] = [side * hipX, ankleY, 0, 0, 0, 1, 0, 1, 0];
        table[knee] = [side * hipX, kneeY, 0, 0, -1, 0, 0, 0, 1];
    }
    return table;
}

export const suitBindTable = bindTable();

export function buildBindMatrices() {
    const bind = new Float32Array(BONE_COUNT * 16);
    const inverseBind = new Float32Array(BONE_COUNT * 16);
    for (let bone = 0; bone < BONE_COUNT; bone++) {
        const entry = suitBindTable[bone];
        setFrameFromDirection(bind, bone * 16, entry[0], entry[1], entry[2], entry[3], entry[4], entry[5], entry[6], entry[7], entry[8]);
        invertRigid(inverseBind, bone * 16, bind, bone * 16);
    }
    return { bind, inverseBind };
}

export function bindJointPosition(bone) {
    const entry = suitBindTable[bone];
    return [entry[0], entry[1], entry[2]];
}

export function solveTwoBoneMiddleJoint(rootX, rootY, rootZ, targetX, targetY, targetZ, poleX, poleY, poleZ, firstLength, secondLength, out, outOffset) {
    let axisX = targetX - rootX;
    let axisY = targetY - rootY;
    let axisZ = targetZ - rootZ;
    let distance = Math.hypot(axisX, axisY, axisZ);
    if (distance < 1e-4) {
        axisX = 0;
        axisY = -1;
        axisZ = 0;
        distance = 1e-4;
    } else {
        axisX /= distance;
        axisY /= distance;
        axisZ /= distance;
    }
    const maximumReach = (firstLength + secondLength) * 0.9995;
    const reachClamped = distance > maximumReach;
    if (reachClamped) {
        distance = maximumReach;
    }
    const alongAxis = (firstLength * firstLength - secondLength * secondLength + distance * distance) / (2 * distance);
    const offAxis = Math.sqrt(Math.max(0, firstLength * firstLength - alongAxis * alongAxis));
    const poleAlongAxis = poleX * axisX + poleY * axisY + poleZ * axisZ;
    let perpendicularX = poleX - axisX * poleAlongAxis;
    let perpendicularY = poleY - axisY * poleAlongAxis;
    let perpendicularZ = poleZ - axisZ * poleAlongAxis;
    const perpendicularLength = Math.hypot(perpendicularX, perpendicularY, perpendicularZ);
    if (perpendicularLength < 1e-6) {
        perpendicularX = 0;
        perpendicularY = 0;
        perpendicularZ = 1;
    } else {
        perpendicularX /= perpendicularLength;
        perpendicularY /= perpendicularLength;
        perpendicularZ /= perpendicularLength;
    }
    out[outOffset] = rootX + axisX * alongAxis + perpendicularX * offAxis;
    out[outOffset + 1] = rootY + axisY * alongAxis + perpendicularY * offAxis;
    out[outOffset + 2] = rootZ + axisZ * alongAxis + perpendicularZ * offAxis;
    return reachClamped;
}

export function composeYawPitchRoll(yawRadians, pitchRadians, rollRadians, out) {
    const cosineYaw = Math.cos(yawRadians);
    const sineYaw = Math.sin(yawRadians);
    let forwardX = sineYaw;
    let forwardY = 0;
    let forwardZ = cosineYaw;
    let rightX = cosineYaw;
    let rightY = 0;
    let rightZ = -sineYaw;
    let upX = 0;
    let upY = 1;
    let upZ = 0;
    const cosinePitch = Math.cos(pitchRadians);
    const sinePitch = Math.sin(pitchRadians);
    const pitchedForwardX = forwardX * cosinePitch - upX * sinePitch;
    const pitchedForwardY = forwardY * cosinePitch - upY * sinePitch;
    const pitchedForwardZ = forwardZ * cosinePitch - upZ * sinePitch;
    const pitchedUpX = upX * cosinePitch + forwardX * sinePitch;
    const pitchedUpY = upY * cosinePitch + forwardY * sinePitch;
    const pitchedUpZ = upZ * cosinePitch + forwardZ * sinePitch;
    forwardX = pitchedForwardX;
    forwardY = pitchedForwardY;
    forwardZ = pitchedForwardZ;
    upX = pitchedUpX;
    upY = pitchedUpY;
    upZ = pitchedUpZ;
    const cosineRoll = Math.cos(rollRadians);
    const sineRoll = Math.sin(rollRadians);
    const rolledRightX = rightX * cosineRoll - upX * sineRoll;
    const rolledRightY = rightY * cosineRoll - upY * sineRoll;
    const rolledRightZ = rightZ * cosineRoll - upZ * sineRoll;
    const rolledUpX = upX * cosineRoll + rightX * sineRoll;
    const rolledUpY = upY * cosineRoll + rightY * sineRoll;
    const rolledUpZ = upZ * cosineRoll + rightZ * sineRoll;
    out[0] = rolledRightX;
    out[1] = rolledRightY;
    out[2] = rolledRightZ;
    out[3] = rolledUpX;
    out[4] = rolledUpY;
    out[5] = rolledUpZ;
    out[6] = forwardX;
    out[7] = forwardY;
    out[8] = forwardZ;
    return out;
}
