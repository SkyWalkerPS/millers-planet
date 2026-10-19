/*
 * Derived from snowflow_demo by Maksymilian Dendura (Noniv): https://github.com/Noniv/snowflow_demo
 * Copyright (c) 2026 Maksymilian Dendura. MIT License; full text in LICENSE.
 */

import {
    BONE_CHEST, BONE_COUNT, BONE_ELBOW_LEFT, BONE_ELBOW_RIGHT, BONE_FOOT_LEFT, BONE_FOOT_RIGHT, BONE_FOREARM_LEFT, BONE_FOREARM_RIGHT,
    BONE_HAND_LEFT, BONE_HAND_RIGHT, BONE_HEAD, BONE_HELMET, BONE_KNEE_LEFT, BONE_KNEE_RIGHT, BONE_NECK, BONE_PELVIS, BONE_SHIN_LEFT,
    BONE_SHIN_RIGHT, BONE_SPINE, BONE_THIGH_LEFT, BONE_THIGH_RIGHT, BONE_UPPER_ARM_LEFT, BONE_UPPER_ARM_RIGHT,
    buildBindMatrices, composeYawPitchRoll, solveTwoBoneMiddleJoint, standingPelvisHeightMetres, suitProportions,
} from "./suitSkeleton.js";
import { multiplyRigid, setFrameFromDirection, transformPoint } from "./rigMath.js";
import { stepCriticallyDampedSpring, wrapAngle } from "./suitController.js";

const degrees = Math.PI / 180;

export const gaitSettings = {
    footSideOffsetMetres: 0.14,
    restLeadMetres: 0.02,
    footRollLengthMetres: 0.18,
    heelStrikePitchRadians: -8 * degrees,
    heelContactFraction: 0.12,
    heelOffStartFraction: 0.7,
    heelLiftAtWalkRadians: 20 * degrees,
    heelLiftAtShiftRadians: 25 * degrees,
    swingApexMetres: 0.16,
    idleStepSeconds: 0.45,
    idleStepApexMetres: 0.08,
    idleStepPositionThresholdMetres: 0.1,
    idleStepYawThresholdRadians: 0.45,
    stoppingMinimumGaitSpeed: 0.6,
    pelvisSpringFrequency: 16,
    reachFraction: 0.99,
    swingReachFraction: 0.995,
    kneeBendBelowStandingMetres: 0.01,
    pelvisSwayMetres: 0.03,
    pelvisTwistRadians: 5 * degrees,
    chestCounterTwistRadians: 3 * degrees,
    chestTwistLagRate: 8,
    torsoPitchStandingRadians: 3 * degrees,
    torsoPitchWalkingRadians: 5 * degrees,
    torsoPitchPerAcceleration: 0.9 * degrees,
    torsoPitchAccelerationLimitRadians: 4 * degrees,
    torsoRollRadians: 1.5 * degrees,
    armSwingMetres: 0.08,
    armForwardMetres: 0.06,
    armOutwardMetres: 0.16,
    handDropMetres: 0.47,
    armLagSeconds: 0.08,
    weightAcceptanceDipMetres: 0.01,
    breathingRiseMetres: 0.004,
    breathsPerMinute: 15,
    idlePitchEaseRate: 8,
    contactToleranceMetres: 0.01,
    braceForwardFootMetres: 0.36,
    braceForwardFootSideMetres: 0.13,
    braceKneelingFootBackMetres: 0.4,
    braceKneelingFootSideMetres: 0.12,
    braceKneelingAnkleHeightMetres: 0.1,
    braceKneelingFootPitchRadians: 55 * degrees,
    bracePelvisHeightMetres: 0.52,
    braceTorsoPitchRadians: 17 * degrees,
    braceHeadLiftRadians: 34 * degrees,
    braceFootLiftMetres: 0.1,
};

function smootherstep(value) {
    const x = clamp(value, 0, 1);
    return x * x * x * (x * (x * 6 - 15) + 10);
}

export const SOLE_POINT_NAMES = ["heel", "mid", "ball", "toe"];
const soleForwardOffsets = [-suitProportions.heelBehindAnkleMetres, 0.05, suitProportions.ballAheadOfAnkleMetres, suitProportions.toeAheadOfAnkleMetres];

export const GAIT_IDLE = 0;
export const GAIT_WALKING = 1;
export const GAIT_STOPPING = 2;
const FOOT_PLANTED = 0;
const FOOT_SWINGING = 1;
const FOOT_IDLE_STEP = 2;
export const FOOT_EVENT_HEEL_STRIKE = 1;
export const FOOT_EVENT_TOE_OFF = 2;
const maximumFootEventsPerFrame = 8;

function clamp(value, low, high) {
    return Math.min(high, Math.max(low, value));
}

function smoothstep(edgeLow, edgeHigh, value) {
    const t = clamp((value - edgeLow) / (edgeHigh - edgeLow), 0, 1);
    return t * t * (3 - 2 * t);
}

export function cadenceStepsPerMinute(speed) {
    return 56.7 + 33.3 * speed;
}

export function strideLengthMetres(speed) {
    return (120 * speed) / cadenceStepsPerMinute(speed);
}

export function dutyFactor(speed) {
    return clamp(0.62 - 0.0667 * (speed - 1), 0.58, 0.7);
}

class FootState {
    constructor(side) {
        this.side = side;
        this.mode = FOOT_PLANTED;
        this.plantAnkle = new Float64Array(3);
        this.plantYaw = 0;
        this.pitch = 0;
        this.ankle = new Float64Array(3);
        this.yaw = 0;
        this.stanceSerial = 0;
        this.swingStartAnkle = new Float64Array(3);
        this.swingStartYaw = 0;
        this.swingStartPitch = 0;
        this.idleStepElapsedSeconds = 0;
        this.target = new Float64Array(3);
        this.targetYaw = 0;
        this.solePoints = new Float64Array(12);
        this.contactMask = 0;
        this.reachExcessMetres = 0;
    }

    get planted() {
        return this.mode === FOOT_PLANTED;
    }
}

export class SuitFigure {
    constructor({ seabedHeightAt, settings = {} }) {
        this.settings = { ...gaitSettings, ...settings };
        this.seabedHeightAt = seabedHeightAt;
        const { bind, inverseBind } = buildBindMatrices();
        this.bind = bind;
        this.inverseBind = inverseBind;
        this.world = new Float32Array(BONE_COUNT * 16);
        this.skin = new Float32Array(BONE_COUNT * 16);
        this.world.set(bind);
        for (let bone = 0; bone < BONE_COUNT; bone++) {
            multiplyRigid(this.skin, bone * 16, this.world, bone * 16, this.inverseBind, bone * 16);
        }
        this.feet = [new FootState(-1), new FootState(1)];
        this.gaitMode = GAIT_IDLE;
        this.phase = 0;
        this.walkAmount = 0;
        this.timeSeconds = 0;
        this.pelvisHeightSpring = { position: 0, velocity: 0 };
        this.dipSpring = { position: 0, velocity: 0 };
        this.chestTwist = 0;
        this.pelvisPosition = new Float64Array(3);
        this.eventKinds = new Int32Array(maximumFootEventsPerFrame);
        this.eventFeet = new Int32Array(maximumFootEventsPerFrame);
        this.eventPositions = new Float64Array(maximumFootEventsPerFrame * 3);
        this.eventYaws = new Float64Array(maximumFootEventsPerFrame);
        this.eventStrengths = new Float64Array(maximumFootEventsPerFrame);
        this.eventCount = 0;
        this.maximumStanceReachExcessMetres = 0;
        this.basis = new Float64Array(9);
        this.chestBasis = new Float64Array(9);
        this.spineBasis = new Float64Array(9);
        this.scratchJoint = new Float64Array(3);
        this.scratchPoint = new Float64Array(3);
        this.hipPositions = new Float64Array(6);
        this.kneePositions = new Float64Array(6);
        this.elbowPositions = new Float64Array(6);
        this.lastSpeed = 0;
        this.braceAmount = 0;
        this.braceAnkle = new Float64Array(3);
        this.headBasis = new Float64Array(9);
    }

    restSpot(controller, foot, out) {
        const settings = this.settings;
        const facing = controller.facingYaw;
        const forwardX = Math.sin(facing);
        const forwardZ = Math.cos(facing);
        const rightX = Math.cos(facing);
        const rightZ = -Math.sin(facing);
        const x = controller.positionX + forwardX * settings.restLeadMetres + rightX * foot.side * settings.footSideOffsetMetres;
        const z = controller.positionZ + forwardZ * settings.restLeadMetres + rightZ * foot.side * settings.footSideOffsetMetres;
        out[0] = x;
        out[1] = this.seabedHeightAt(x, z) + suitProportions.soleBelowAnkleMetres;
        out[2] = z;
        return out;
    }

    teleport(controller) {
        for (const foot of this.feet) {
            this.restSpot(controller, foot, foot.plantAnkle);
            foot.plantYaw = controller.facingYaw;
            foot.yaw = foot.plantYaw;
            foot.pitch = 0;
            foot.mode = FOOT_PLANTED;
            foot.ankle.set(foot.plantAnkle);
        }
        this.gaitMode = GAIT_IDLE;
        this.phase = 0;
        this.walkAmount = 0;
        this.pelvisHeightSpring.position = controller.positionY + standingPelvisHeightMetres - this.settings.kneeBendBelowStandingMetres;
        this.pelvisHeightSpring.velocity = 0;
        this.dipSpring.position = 0;
        this.dipSpring.velocity = 0;
        this.chestTwist = 0;
    }

    shiftOrigin(deltaX, deltaZ) {
        for (const foot of this.feet) {
            for (const points of [foot.plantAnkle, foot.ankle, foot.swingStartAnkle, foot.target]) {
                points[0] -= deltaX;
                points[2] -= deltaZ;
            }
            for (let point = 0; point < 4; point++) {
                foot.solePoints[point * 3] -= deltaX;
                foot.solePoints[point * 3 + 2] -= deltaZ;
            }
        }
        for (const positions of [this.pelvisPosition, this.hipPositions, this.kneePositions, this.elbowPositions, this.eventPositions]) {
            for (let index = 0; index < positions.length; index += 3) {
                positions[index] -= deltaX;
                positions[index + 2] -= deltaZ;
            }
        }
        for (let bone = 0; bone < BONE_COUNT; bone++) {
            this.world[bone * 16 + 12] -= deltaX;
            this.world[bone * 16 + 14] -= deltaZ;
            multiplyRigid(this.skin, bone * 16, this.world, bone * 16, this.inverseBind, bone * 16);
        }
    }

    pushFootEvent(kind, footIndex, x, y, z, yaw, strength) {
        if (this.eventCount >= maximumFootEventsPerFrame) {
            return;
        }
        const index = this.eventCount++;
        this.eventKinds[index] = kind;
        this.eventFeet[index] = footIndex;
        this.eventPositions[index * 3] = x;
        this.eventPositions[index * 3 + 1] = y;
        this.eventPositions[index * 3 + 2] = z;
        this.eventYaws[index] = yaw;
        this.eventStrengths[index] = strength;
    }

    ankleFromPlant(flatAnkle, yaw, pitch, out) {
        const forwardX = Math.sin(yaw);
        const forwardZ = Math.cos(yaw);
        const pivotForward = pitch < 0 ? -suitProportions.heelBehindAnkleMetres : suitProportions.toeAheadOfAnkleMetres;
        const soleBelow = suitProportions.soleBelowAnkleMetres;
        const alongForward = -pivotForward;
        const cosine = Math.cos(pitch);
        const sine = Math.sin(pitch);
        const rotatedForward = alongForward * cosine + soleBelow * sine;
        const rotatedUp = soleBelow * cosine - alongForward * sine;
        out[0] = flatAnkle[0] + forwardX * (pivotForward + rotatedForward);
        out[1] = flatAnkle[1] - soleBelow + rotatedUp;
        out[2] = flatAnkle[2] + forwardZ * (pivotForward + rotatedForward);
        return out;
    }

    touchdown(foot, footIndex, strength) {
        foot.plantAnkle.set(foot.target);
        foot.plantYaw = foot.targetYaw;
        foot.mode = FOOT_PLANTED;
        foot.stanceSerial++;
        const heelX = foot.plantAnkle[0] - Math.sin(foot.plantYaw) * suitProportions.heelBehindAnkleMetres;
        const heelZ = foot.plantAnkle[2] - Math.cos(foot.plantYaw) * suitProportions.heelBehindAnkleMetres;
        this.pushFootEvent(FOOT_EVENT_HEEL_STRIKE, footIndex, heelX, foot.plantAnkle[1] - suitProportions.soleBelowAnkleMetres, heelZ, foot.plantYaw, strength);
        this.dipSpring.velocity -= this.settings.weightAcceptanceDipMetres * 14 * strength;
    }

    liftOff(foot, footIndex, strength) {
        foot.swingStartAnkle.set(foot.ankle);
        foot.swingStartYaw = foot.yaw;
        foot.swingStartPitch = foot.pitch;
        const toeX = foot.plantAnkle[0] + Math.sin(foot.plantYaw) * suitProportions.toeAheadOfAnkleMetres;
        const toeZ = foot.plantAnkle[2] + Math.cos(foot.plantYaw) * suitProportions.toeAheadOfAnkleMetres;
        this.pushFootEvent(FOOT_EVENT_TOE_OFF, footIndex, toeX, foot.plantAnkle[1] - suitProportions.soleBelowAnkleMetres, toeZ, foot.plantYaw, strength);
    }

    walkingTarget(controller, foot, speed, out) {
        const settings = this.settings;
        const lead = Math.max(settings.restLeadMetres, (dutyFactor(speed) * strideLengthMetres(speed) - settings.footRollLengthMetres) * 0.5);
        const facing = controller.facingYaw;
        const x = controller.positionX + Math.sin(facing) * lead + Math.cos(facing) * foot.side * settings.footSideOffsetMetres;
        const z = controller.positionZ + Math.cos(facing) * lead - Math.sin(facing) * foot.side * settings.footSideOffsetMetres;
        out[0] = x;
        out[1] = this.seabedHeightAt(x, z) + suitProportions.soleBelowAnkleMetres;
        out[2] = z;
        return out;
    }

    swingPose(foot, swingFraction, apexMetres, heelStrikePitch) {
        const easedFraction = smoothstep(0, 1, Math.pow(swingFraction, 1.25));
        const touchdownAnkle = this.scratchPoint;
        this.ankleFromPlant(foot.target, foot.targetYaw, heelStrikePitch, touchdownAnkle);
        const arc = apexMetres * Math.pow(Math.sin(Math.PI * swingFraction), 0.8);
        for (let axis = 0; axis < 3; axis++) {
            foot.ankle[axis] = foot.swingStartAnkle[axis] + (touchdownAnkle[axis] - foot.swingStartAnkle[axis]) * easedFraction;
        }
        foot.ankle[1] += arc;
        foot.yaw = foot.swingStartYaw + wrapAngle(foot.targetYaw - foot.swingStartYaw) * easedFraction;
        if (swingFraction < 0.3) {
            foot.pitch = foot.swingStartPitch * (1 - smoothstep(0, 0.3, swingFraction));
        } else if (swingFraction > 0.85) {
            foot.pitch = heelStrikePitch * smoothstep(0.85, 1, swingFraction);
        } else {
            foot.pitch = 0;
        }
    }

    plantedPose(foot) {
        this.ankleFromPlant(foot.plantAnkle, foot.plantYaw, foot.pitch, foot.ankle);
        foot.yaw = foot.plantYaw;
    }

    startWalking(controller) {
        const facing = controller.facingYaw;
        const forwardX = Math.sin(facing);
        const forwardZ = Math.cos(facing);
        const leftBehind = (this.feet[0].plantAnkle[0] - controller.positionX) * forwardX + (this.feet[0].plantAnkle[2] - controller.positionZ) * forwardZ;
        const rightBehind = (this.feet[1].plantAnkle[0] - controller.positionX) * forwardX + (this.feet[1].plantAnkle[2] - controller.positionZ) * forwardZ;
        const duty = dutyFactor(Math.max(controller.planarSpeed, 0.15));
        const firstSwingFootIndex = leftBehind <= rightBehind ? 0 : 1;
        this.phase = firstSwingFootIndex === 0 ? duty + 1e-4 : (duty + 0.5 + 1e-4) % 1;
        this.gaitMode = GAIT_WALKING;
        for (let footIndex = 0; footIndex < 2; footIndex++) {
            const foot = this.feet[footIndex];
            if (footIndex === firstSwingFootIndex) {
                foot.mode = FOOT_SWINGING;
                this.liftOff(foot, footIndex, 0.3);
            }
        }
    }

    updateWalkingFeet(controller, step) {
        const settings = this.settings;
        const speed = controller.planarSpeed;
        const gaitSpeed = this.gaitMode === GAIT_STOPPING ? Math.max(speed, settings.stoppingMinimumGaitSpeed) : Math.max(speed, 0.15);
        this.phase = (this.phase + (cadenceStepsPerMinute(gaitSpeed) / 120) * step) % 1;
        const duty = dutyFactor(gaitSpeed);
        const heelLift = settings.heelLiftAtWalkRadians + (settings.heelLiftAtShiftRadians - settings.heelLiftAtWalkRadians) * clamp((speed - controller.settings.walkSpeedMetresPerSecond) / (controller.settings.shiftSpeedMetresPerSecond - controller.settings.walkSpeedMetresPerSecond), 0, 1);
        const impact = clamp(0.35 + 0.6 * speed, 0, 1.2);
        for (let footIndex = 0; footIndex < 2; footIndex++) {
            const foot = this.feet[footIndex];
            const footPhase = (this.phase + (footIndex === 0 ? 0 : 0.5)) % 1;
            const inStance = footPhase < duty;
            if (foot.mode === FOOT_SWINGING && inStance) {
                this.walkingTarget(controller, foot, speed, foot.target);
                foot.targetYaw = controller.facingYaw;
                this.touchdown(foot, footIndex, impact);
                foot.pitch = settings.heelStrikePitchRadians;
            } else if (foot.mode === FOOT_PLANTED && !inStance) {
                const other = this.feet[1 - footIndex];
                if (this.gaitMode === GAIT_STOPPING && other.mode === FOOT_PLANTED) {
                    this.gaitMode = GAIT_IDLE;
                    return;
                }
                this.liftOff(foot, footIndex, impact * 0.5);
                foot.mode = FOOT_SWINGING;
            }
            if (foot.mode === FOOT_PLANTED) {
                const stanceFraction = footPhase / duty;
                if (stanceFraction < settings.heelContactFraction) {
                    foot.pitch = settings.heelStrikePitchRadians * (1 - smoothstep(0, settings.heelContactFraction, stanceFraction));
                } else if (stanceFraction > settings.heelOffStartFraction) {
                    foot.pitch = heelLift * smoothstep(settings.heelOffStartFraction, 1, stanceFraction);
                } else {
                    foot.pitch = 0;
                }
                this.plantedPose(foot);
            } else {
                this.walkingTarget(controller, foot, speed, foot.target);
                foot.targetYaw = controller.facingYaw;
                const swingFraction = (footPhase - duty) / (1 - duty);
                this.swingPose(foot, swingFraction, settings.swingApexMetres, settings.heelStrikePitchRadians);
            }
        }
    }

    updateIdleFeet(controller, step) {
        const settings = this.settings;
        let steppingFoot = null;
        for (const foot of this.feet) {
            if (foot.mode === FOOT_IDLE_STEP) {
                steppingFoot = foot;
            }
        }
        for (let footIndex = 0; footIndex < 2; footIndex++) {
            const foot = this.feet[footIndex];
            if (foot.mode === FOOT_PLANTED) {
                if (foot.pitch !== 0) {
                    const eased = foot.pitch * Math.exp(-settings.idlePitchEaseRate * step);
                    foot.pitch = Math.abs(eased) < 1e-4 ? 0 : eased;
                }
                this.plantedPose(foot);
            } else if (foot.mode === FOOT_SWINGING) {
                foot.mode = FOOT_IDLE_STEP;
                foot.idleStepElapsedSeconds = 0;
                steppingFoot = foot;
            }
        }
        if (!steppingFoot) {
            let worstFootIndex = -1;
            let worstScore = 1;
            for (let footIndex = 0; footIndex < 2; footIndex++) {
                const foot = this.feet[footIndex];
                const other = this.feet[1 - footIndex];
                if (other.mode !== FOOT_PLANTED || Math.abs(other.pitch) > 2 * degrees) {
                    continue;
                }
                this.restSpot(controller, foot, this.scratchPoint);
                const positionError = Math.hypot(foot.plantAnkle[0] - this.scratchPoint[0], foot.plantAnkle[2] - this.scratchPoint[2]);
                const yawError = Math.abs(wrapAngle(foot.plantYaw - controller.facingYaw));
                const score = Math.max(positionError / settings.idleStepPositionThresholdMetres, yawError / settings.idleStepYawThresholdRadians);
                if (score > worstScore) {
                    worstScore = score;
                    worstFootIndex = footIndex;
                }
            }
            if (worstFootIndex >= 0) {
                const foot = this.feet[worstFootIndex];
                this.liftOff(foot, worstFootIndex, 0.15);
                foot.mode = FOOT_IDLE_STEP;
                foot.idleStepElapsedSeconds = 0;
                steppingFoot = foot;
            }
        }
        if (steppingFoot) {
            const footIndex = this.feet.indexOf(steppingFoot);
            steppingFoot.idleStepElapsedSeconds += step;
            this.restSpot(controller, steppingFoot, steppingFoot.target);
            steppingFoot.targetYaw = controller.facingYaw;
            const fraction = steppingFoot.idleStepElapsedSeconds / settings.idleStepSeconds;
            if (fraction >= 1) {
                this.touchdown(steppingFoot, footIndex, 0.25);
                steppingFoot.pitch = 0;
                this.plantedPose(steppingFoot);
            } else {
                this.swingPose(steppingFoot, fraction, settings.idleStepApexMetres, 0);
            }
        }
    }

    updateGait(controller, step) {
        if (this.gaitMode === GAIT_WALKING && (!controller.hasMoveInput || controller.turningInPlace)) {
            this.gaitMode = GAIT_STOPPING;
        } else if (this.gaitMode === GAIT_STOPPING && controller.hasMoveInput && !controller.turningInPlace) {
            this.gaitMode = GAIT_WALKING;
        }
        if (this.gaitMode === GAIT_IDLE && controller.hasMoveInput && !controller.turningInPlace && controller.planarSpeed > 0.02) {
            const idleStepActive = this.feet[0].mode === FOOT_IDLE_STEP || this.feet[1].mode === FOOT_IDLE_STEP;
            if (!idleStepActive) {
                this.startWalking(controller);
            }
        }
        if (this.gaitMode === GAIT_IDLE) {
            this.updateIdleFeet(controller, step);
        } else {
            this.updateWalkingFeet(controller, step);
            if (this.gaitMode === GAIT_IDLE) {
                this.updateIdleFeet(controller, 0);
            }
        }
    }

    writeBone(bone, positionX, positionY, positionZ, directionX, directionY, directionZ, referenceX, referenceY, referenceZ) {
        setFrameFromDirection(this.world, bone * 16, positionX, positionY, positionZ, directionX, directionY, directionZ, referenceX, referenceY, referenceZ);
    }

    poseLeg(footIndex, thighBone, shinBone, footBone, kneeBone) {
        const settings = this.settings;
        const proportions = suitProportions;
        const foot = this.feet[footIndex];
        const basis = this.basis;
        const hipX = this.hipPositions[footIndex * 3];
        const hipY = this.hipPositions[footIndex * 3 + 1];
        const hipZ = this.hipPositions[footIndex * 3 + 2];
        const legLength = proportions.thighLengthMetres + proportions.shinLengthMetres;
        let toAnkleX = foot.ankle[0] - hipX;
        let toAnkleY = foot.ankle[1] - hipY;
        let toAnkleZ = foot.ankle[2] - hipZ;
        const span = Math.hypot(toAnkleX, toAnkleY, toAnkleZ);
        foot.reachExcessMetres = span - legLength * settings.reachFraction;
        if (!foot.planted && span > legLength * settings.swingReachFraction) {
            const shrink = (legLength * settings.swingReachFraction) / span;
            toAnkleX *= shrink;
            toAnkleY *= shrink;
            toAnkleZ *= shrink;
            foot.ankle[0] = hipX + toAnkleX;
            foot.ankle[1] = hipY + toAnkleY;
            foot.ankle[2] = hipZ + toAnkleZ;
        }
        const poleX = basis[6] + basis[0] * foot.side * 0.22;
        const poleY = basis[7] + basis[1] * foot.side * 0.22;
        const poleZ = basis[8] + basis[2] * foot.side * 0.22;
        const knee = this.scratchJoint;
        solveTwoBoneMiddleJoint(hipX, hipY, hipZ, foot.ankle[0], foot.ankle[1], foot.ankle[2], poleX, poleY, poleZ, proportions.thighLengthMetres, proportions.shinLengthMetres, knee, 0);
        this.kneePositions[footIndex * 3] = knee[0];
        this.kneePositions[footIndex * 3 + 1] = knee[1];
        this.kneePositions[footIndex * 3 + 2] = knee[2];
        const thighX = knee[0] - hipX;
        const thighY = knee[1] - hipY;
        const thighZ = knee[2] - hipZ;
        const shinX = foot.ankle[0] - knee[0];
        const shinY = foot.ankle[1] - knee[1];
        const shinZ = foot.ankle[2] - knee[2];
        const footForwardX = Math.sin(foot.yaw);
        const footForwardZ = Math.cos(foot.yaw);
        this.writeBone(thighBone, hipX, hipY, hipZ, thighX, thighY, thighZ, basis[6], basis[7], basis[8]);
        this.writeBone(shinBone, knee[0], knee[1], knee[2], shinX, shinY, shinZ, (basis[6] + footForwardX) * 0.5, basis[7] * 0.5, (basis[8] + footForwardZ) * 0.5);
        const thighLength = Math.hypot(thighX, thighY, thighZ) || 1;
        const shinLength = Math.hypot(shinX, shinY, shinZ) || 1;
        this.writeBone(kneeBone, knee[0], knee[1], knee[2], thighX / thighLength + shinX / shinLength, thighY / thighLength + shinY / shinLength, thighZ / thighLength + shinZ / shinLength, basis[6], basis[7], basis[8]);
        const cosinePitch = Math.cos(foot.pitch);
        const sinePitch = Math.sin(foot.pitch);
        this.writeBone(
            footBone, foot.ankle[0], foot.ankle[1], foot.ankle[2],
            footForwardX * cosinePitch, -sinePitch, footForwardZ * cosinePitch,
            footForwardX * sinePitch, cosinePitch, footForwardZ * sinePitch,
        );
        const offset = footBone * 16;
        let mask = 0;
        for (let pointIndex = 0; pointIndex < 4; pointIndex++) {
            transformPoint(this.world, offset, 0, soleForwardOffsets[pointIndex], -proportions.soleBelowAnkleMetres, foot.solePoints, pointIndex * 3);
            const pointX = foot.solePoints[pointIndex * 3];
            const pointY = foot.solePoints[pointIndex * 3 + 1];
            const pointZ = foot.solePoints[pointIndex * 3 + 2];
            if (pointY - this.seabedHeightAt(pointX, pointZ) < settings.contactToleranceMetres) {
                mask |= 1 << pointIndex;
            }
        }
        foot.contactMask = mask;
    }

    poseArm(sideIndex, upperBone, foreBone, handBone, elbowBone) {
        const settings = this.settings;
        const proportions = suitProportions;
        const side = sideIndex === 0 ? -1 : 1;
        const chest = this.chestBasis;
        const chestPositionX = this.world[BONE_CHEST * 16 + 12];
        const chestPositionY = this.world[BONE_CHEST * 16 + 13];
        const chestPositionZ = this.world[BONE_CHEST * 16 + 14];
        const shoulderX = chestPositionX + chest[0] * side * proportions.shoulderHalfWidthMetres + chest[3] * proportions.shoulderRiseAboveChestMetres;
        const shoulderY = chestPositionY + chest[1] * side * proportions.shoulderHalfWidthMetres + chest[4] * proportions.shoulderRiseAboveChestMetres;
        const shoulderZ = chestPositionZ + chest[2] * side * proportions.shoulderHalfWidthMetres + chest[5] * proportions.shoulderRiseAboveChestMetres;
        const lagPhase = this.phase - settings.armLagSeconds * (cadenceStepsPerMinute(this.lastSpeed) / 120);
        const swing = side * settings.armSwingMetres * Math.cos(2 * Math.PI * lagPhase) * this.walkAmount;
        const forward = settings.armForwardMetres + swing;
        let handX = shoulderX + chest[6] * forward - chest[3] * settings.handDropMetres + chest[0] * side * settings.armOutwardMetres;
        let handY = shoulderY + chest[7] * forward - chest[4] * settings.handDropMetres + chest[1] * side * settings.armOutwardMetres;
        let handZ = shoulderZ + chest[8] * forward - chest[5] * settings.handDropMetres + chest[2] * side * settings.armOutwardMetres;
        const brace = smootherstep(this.braceAmount);
        if (brace > 0) {
            const kneeX = this.kneePositions[0];
            const kneeY = this.kneePositions[1];
            const kneeZ = this.kneePositions[2];
            const lateral = sideIndex === 0 ? -0.07 : 0.06;
            const rise = sideIndex === 0 ? 0.07 : 0.11;
            handX += (kneeX + chest[0] * lateral + chest[6] * 0.02 - handX) * brace;
            handY += (kneeY + rise - handY) * brace;
            handZ += (kneeZ + chest[2] * lateral + chest[8] * 0.02 - handZ) * brace;
        }
        const poleX = -chest[6] + chest[0] * side * 0.55;
        const poleY = -chest[7] + chest[1] * side * 0.55 - 0.35;
        const poleZ = -chest[8] + chest[2] * side * 0.55;
        const elbow = this.scratchJoint;
        solveTwoBoneMiddleJoint(shoulderX, shoulderY, shoulderZ, handX, handY, handZ, poleX, poleY, poleZ, proportions.upperArmLengthMetres, proportions.forearmLengthMetres, elbow, 0);
        this.elbowPositions[sideIndex * 3] = elbow[0];
        this.elbowPositions[sideIndex * 3 + 1] = elbow[1];
        this.elbowPositions[sideIndex * 3 + 2] = elbow[2];
        const upperX = elbow[0] - shoulderX;
        const upperY = elbow[1] - shoulderY;
        const upperZ = elbow[2] - shoulderZ;
        const foreX = handX - elbow[0];
        const foreY = handY - elbow[1];
        const foreZ = handZ - elbow[2];
        this.writeBone(upperBone, shoulderX, shoulderY, shoulderZ, upperX, upperY, upperZ, chest[6], chest[7], chest[8]);
        this.writeBone(foreBone, elbow[0], elbow[1], elbow[2], foreX, foreY, foreZ, chest[6], chest[7], chest[8]);
        this.writeBone(handBone, handX, handY, handZ, foreX, foreY, foreZ, chest[6], chest[7], chest[8]);
        const upperLength = Math.hypot(upperX, upperY, upperZ) || 1;
        const foreLength = Math.hypot(foreX, foreY, foreZ) || 1;
        this.writeBone(elbowBone, elbow[0], elbow[1], elbow[2], upperX / upperLength + foreX / foreLength, upperY / upperLength + foreY / foreLength, upperZ / upperLength + foreZ / foreLength, chest[6], chest[7], chest[8]);
    }

    applyBraceToFeet(controller, brace) {
        const settings = this.settings;
        const facing = controller.facingYaw;
        const forwardX = Math.sin(facing);
        const forwardZ = Math.cos(facing);
        const rightX = Math.cos(facing);
        const rightZ = -Math.sin(facing);
        const target = this.braceAnkle;
        for (let footIndex = 0; footIndex < 2; footIndex++) {
            const foot = this.feet[footIndex];
            const kneeling = footIndex === 1;
            const along = kneeling ? -settings.braceKneelingFootBackMetres : settings.braceForwardFootMetres;
            const across = foot.side * (kneeling ? settings.braceKneelingFootSideMetres : settings.braceForwardFootSideMetres);
            target[0] = controller.positionX + forwardX * along + rightX * across;
            target[2] = controller.positionZ + forwardZ * along + rightZ * across;
            target[1] = this.seabedHeightAt(target[0], target[2]) + (kneeling ? settings.braceKneelingAnkleHeightMetres : suitProportions.soleBelowAnkleMetres);
            const lift = Math.sin(Math.PI * brace) * settings.braceFootLiftMetres * (1 - brace * 0.5);
            for (let axis = 0; axis < 3; axis++) {
                foot.ankle[axis] += (target[axis] - foot.ankle[axis]) * brace;
            }
            foot.ankle[1] += lift;
            foot.yaw += wrapAngle(facing - foot.yaw) * brace;
            foot.pitch += ((kneeling ? settings.braceKneelingFootPitchRadians : 0) - foot.pitch) * brace;
        }
    }

    update(deltaSeconds, controller) {
        const settings = this.settings;
        const proportions = suitProportions;
        const step = Math.min(Math.max(deltaSeconds, 0), 1 / 30);
        this.eventCount = 0;
        this.timeSeconds += step;
        if (step > 0 && this.braceAmount <= 0) {
            this.updateGait(controller, step);
        } else {
            for (const foot of this.feet) {
                if (foot.planted) {
                    this.plantedPose(foot);
                }
            }
        }
        const brace = smootherstep(this.braceAmount);
        if (brace > 0) {
            this.applyBraceToFeet(controller, brace);
        }
        const speed = controller.planarSpeed;
        this.lastSpeed = speed;
        const walkTarget = this.gaitMode === GAIT_IDLE ? 0 : clamp(speed / 0.5, 0, 1);
        this.walkAmount = walkTarget + (this.walkAmount - walkTarget) * Math.exp(-6 * step);
        const facing = controller.facingYaw;
        const cyclePhase = 2 * Math.PI * this.phase;
        const stanceCentrePhase = dutyFactor(Math.max(speed, 0.15)) * 0.5;
        const swayToLeft = Math.cos(2 * Math.PI * (this.phase - stanceCentrePhase)) * this.walkAmount;
        const twist = settings.pelvisTwistRadians * Math.cos(cyclePhase) * this.walkAmount;
        const accelerationPitch = clamp(settings.torsoPitchPerAcceleration * controller.forwardAcceleration, -settings.torsoPitchAccelerationLimitRadians, settings.torsoPitchAccelerationLimitRadians);
        const pelvisPitch = settings.torsoPitchStandingRadians + (settings.torsoPitchWalkingRadians - settings.torsoPitchStandingRadians) * this.walkAmount + accelerationPitch + settings.braceTorsoPitchRadians * brace;
        const roll = -settings.torsoRollRadians * swayToLeft;
        const basis = composeYawPitchRoll(facing + twist, pelvisPitch * 0.5, roll, this.basis);
        const rightX = Math.cos(facing);
        const rightZ = -Math.sin(facing);
        const pelvisX = controller.positionX - rightX * settings.pelvisSwayMetres * swayToLeft;
        const pelvisZ = controller.positionZ - rightZ * settings.pelvisSwayMetres * swayToLeft;
        const legLength = proportions.thighLengthMetres + proportions.shinLengthMetres;
        const reach = legLength * settings.reachFraction;
        let constraint = Infinity;
        for (let footIndex = 0; footIndex < 2; footIndex++) {
            const foot = this.feet[footIndex];
            const hipOffsetX = basis[0] * foot.side * proportions.hipHalfWidthMetres - basis[3] * proportions.hipDropBelowPelvisMetres;
            const hipOffsetY = basis[1] * foot.side * proportions.hipHalfWidthMetres - basis[4] * proportions.hipDropBelowPelvisMetres;
            const hipOffsetZ = basis[2] * foot.side * proportions.hipHalfWidthMetres - basis[5] * proportions.hipDropBelowPelvisMetres;
            this.hipPositions[footIndex * 3] = pelvisX + hipOffsetX;
            this.hipPositions[footIndex * 3 + 2] = pelvisZ + hipOffsetZ;
            this.hipPositions[footIndex * 3 + 1] = hipOffsetY;
            if (!foot.planted) {
                continue;
            }
            const horizontal = Math.hypot(this.hipPositions[footIndex * 3] - foot.ankle[0], this.hipPositions[footIndex * 3 + 2] - foot.ankle[2]);
            const vertical = horizontal < reach ? Math.sqrt(reach * reach - horizontal * horizontal) : 0;
            constraint = Math.min(constraint, foot.ankle[1] + vertical - hipOffsetY);
        }
        const nominal = controller.positionY + standingPelvisHeightMetres - settings.kneeBendBelowStandingMetres;
        const standingTarget = Math.min(nominal, constraint);
        const target = standingTarget + (controller.positionY + settings.bracePelvisHeightMetres - standingTarget) * brace;
        stepCriticallyDampedSpring(this.pelvisHeightSpring, target, settings.pelvisSpringFrequency, step);
        if (this.pelvisHeightSpring.position > constraint) {
            this.pelvisHeightSpring.position = constraint;
            this.pelvisHeightSpring.velocity = Math.min(0, this.pelvisHeightSpring.velocity);
        }
        if (step > 0) {
            const dip = this.dipSpring;
            const dipFrequency = 14;
            const dampingRatio = 0.45;
            dip.velocity += (-dipFrequency * dipFrequency * dip.position - 2 * dampingRatio * dipFrequency * dip.velocity) * step;
            dip.position += dip.velocity * step;
        }
        const breathing = settings.breathingRiseMetres * 0.5 * (1 - Math.cos(2 * Math.PI * this.timeSeconds * settings.breathsPerMinute / 60));
        const pelvisY = Math.min(this.pelvisHeightSpring.position + this.dipSpring.position, constraint);
        this.pelvisPosition[0] = pelvisX;
        this.pelvisPosition[1] = pelvisY;
        this.pelvisPosition[2] = pelvisZ;
        for (let footIndex = 0; footIndex < 2; footIndex++) {
            this.hipPositions[footIndex * 3 + 1] += pelvisY;
            const foot = this.feet[footIndex];
            if (foot.planted) {
                const span = Math.hypot(foot.ankle[0] - this.hipPositions[footIndex * 3], foot.ankle[1] - this.hipPositions[footIndex * 3 + 1], foot.ankle[2] - this.hipPositions[footIndex * 3 + 2]);
                this.maximumStanceReachExcessMetres = Math.max(this.maximumStanceReachExcessMetres, span - reach);
            }
        }
        this.writeBone(BONE_PELVIS, pelvisX, pelvisY, pelvisZ, basis[3], basis[4], basis[5], basis[6], basis[7], basis[8]);
        const chestTwistTarget = -settings.chestCounterTwistRadians * Math.cos(cyclePhase) * this.walkAmount;
        this.chestTwist = chestTwistTarget + (this.chestTwist - chestTwistTarget) * Math.exp(-settings.chestTwistLagRate * step);
        const spineBasis = composeYawPitchRoll(facing + twist * 0.5 + this.chestTwist * 0.5, pelvisPitch * 0.75, roll * 1.05, this.spineBasis);
        const spineX = pelvisX + basis[3] * proportions.pelvisAboveSpineMetres;
        const spineY = pelvisY + basis[4] * proportions.pelvisAboveSpineMetres;
        const spineZ = pelvisZ + basis[5] * proportions.pelvisAboveSpineMetres;
        this.writeBone(BONE_SPINE, spineX, spineY, spineZ, spineBasis[3], spineBasis[4], spineBasis[5], spineBasis[6], spineBasis[7], spineBasis[8]);
        const chest = composeYawPitchRoll(facing + this.chestTwist, pelvisPitch, roll * 1.15, this.chestBasis);
        const chestRise = proportions.chestAbovePelvisMetres - proportions.pelvisAboveSpineMetres;
        const chestX = spineX + spineBasis[3] * chestRise;
        const chestY = spineY + spineBasis[4] * chestRise + breathing;
        const chestZ = spineZ + spineBasis[5] * chestRise;
        this.writeBone(BONE_CHEST, chestX, chestY, chestZ, chest[3], chest[4], chest[5], chest[6], chest[7], chest[8]);
        const neckX = chestX + chest[3] * proportions.neckAboveChestMetres;
        const neckY = chestY + chest[4] * proportions.neckAboveChestMetres;
        const neckZ = chestZ + chest[5] * proportions.neckAboveChestMetres;
        this.writeBone(BONE_NECK, neckX, neckY, neckZ, chest[3], chest[4], chest[5], chest[6], chest[7], chest[8]);
        const head = composeYawPitchRoll(facing + this.chestTwist, pelvisPitch - settings.braceHeadLiftRadians * brace, roll * 1.15, this.headBasis);
        this.writeBone(BONE_HEAD, neckX + head[3] * proportions.headAboveNeckMetres, neckY + head[4] * proportions.headAboveNeckMetres, neckZ + head[5] * proportions.headAboveNeckMetres, head[3], head[4], head[5], head[6], head[7], head[8]);
        this.writeBone(
            BONE_HELMET,
            neckX + head[3] * proportions.helmetCentreAboveNeckMetres + head[6] * proportions.helmetCentreForwardMetres,
            neckY + head[4] * proportions.helmetCentreAboveNeckMetres + head[7] * proportions.helmetCentreForwardMetres,
            neckZ + head[5] * proportions.helmetCentreAboveNeckMetres + head[8] * proportions.helmetCentreForwardMetres,
            head[3], head[4], head[5], head[6], head[7], head[8],
        );
        this.poseLeg(0, BONE_THIGH_LEFT, BONE_SHIN_LEFT, BONE_FOOT_LEFT, BONE_KNEE_LEFT);
        this.poseLeg(1, BONE_THIGH_RIGHT, BONE_SHIN_RIGHT, BONE_FOOT_RIGHT, BONE_KNEE_RIGHT);
        this.poseArm(0, BONE_UPPER_ARM_LEFT, BONE_FOREARM_LEFT, BONE_HAND_LEFT, BONE_ELBOW_LEFT);
        this.poseArm(1, BONE_UPPER_ARM_RIGHT, BONE_FOREARM_RIGHT, BONE_HAND_RIGHT, BONE_ELBOW_RIGHT);
        for (let bone = 0; bone < BONE_COUNT; bone++) {
            multiplyRigid(this.skin, bone * 16, this.world, bone * 16, this.inverseBind, bone * 16);
        }
    }

    eyePosition(out) {
        transformPoint(this.world, BONE_HEAD * 16, 0, suitProportions.eyeAboveHeadMetres, suitProportions.eyeForwardOfHeadMetres, out, 0);
        return out;
    }
}
