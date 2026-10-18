import { stepCriticallyDampedSpring, wrapAngle } from "../character/suitController.js";

const degrees = Math.PI / 180;

export const PRESET_THIRD_PERSON = 0;
export const PRESET_CLOSE = 1;
export const PRESET_FIRST_PERSON = 2;

export const cameraPresets = [
    { name: "third person", pivotHeightMetres: 1.45, shoulderMetres: 0.62, verticalArmMetres: 0.12, distanceMetres: 3.2, verticalFieldOfViewDegrees: 56, defaultPitchDegrees: 2.7, pitchDownLimitDegrees: -30, pitchUpLimitDegrees: 60, lookUpDistanceScale: 0.55, yawPerCount: 0.0018, pitchPerCount: 0.0016, firstPerson: 0 },
    { name: "close third person", pivotHeightMetres: 1.52, shoulderMetres: 0.48, verticalArmMetres: 0.1, distanceMetres: 1.8, verticalFieldOfViewDegrees: 50, defaultPitchDegrees: 2.5, pitchDownLimitDegrees: -30, pitchUpLimitDegrees: 60, lookUpDistanceScale: 0.9, yawPerCount: 0.0017, pitchPerCount: 0.0015, firstPerson: 0 },
    { name: "first person", pivotHeightMetres: 1.7, shoulderMetres: 0, verticalArmMetres: 0, distanceMetres: 0, verticalFieldOfViewDegrees: 62, defaultPitchDegrees: 0, pitchDownLimitDegrees: -65, pitchUpLimitDegrees: 70, lookUpDistanceScale: 1, yawPerCount: 0.0015, pitchPerCount: 0.0013, firstPerson: 1 },
];

export const cameraRigSettings = {
    horizontalPivotFrequency: 9,
    verticalPivotFrequency: 6,
    leadSeconds: 0.12,
    blendSecondsBetweenThirdPersonPresets: 0.6,
    blendSecondsIntoOrOutOfFirstPerson: 0.75,
    seaClearanceMetres: 0.3,
    clearanceRiseRate: 26,
    clearanceRelaxRate: 4.5,
    recentreDelaySeconds: 1.2,
    recentreMinimumSpeed: 0.3,
    recentreMaximumErrorRadians: 120 * degrees,
    recentreTimeConstantSeconds: 1.6,
    recentreMaximumRateRadiansPerSecond: 35 * degrees,
    pitchReturnDelaySeconds: 2.5,
    pitchReturnTimeConstantSeconds: 2.0,
    pitchReturnMaximumRateRadiansPerSecond: 15 * degrees,
    swayYawRadians: 0.15 * degrees,
    swayPitchRadians: 0.12 * degrees,
    firstPersonSwayScale: 0.5,
};

function smootherstep(value) {
    const t = Math.min(1, Math.max(0, value));
    return t * t * t * (t * (t * 6 - 15) + 10);
}

function smoothstep(edgeLow, edgeHigh, value) {
    const t = Math.min(1, Math.max(0, (value - edgeLow) / (edgeHigh - edgeLow)));
    return t * t * (3 - 2 * t);
}

export class CameraRig {
    constructor({ settings = {} } = {}) {
        this.settings = { ...cameraRigSettings, ...settings };
        this.presetIndex = PRESET_THIRD_PERSON;
        this.previousPresetIndex = PRESET_THIRD_PERSON;
        this.blendElapsedSeconds = 1;
        this.blendDurationSeconds = 1;
        this.yawRadians = 0;
        this.pitchRadians = cameraPresets[PRESET_THIRD_PERSON].defaultPitchDegrees * degrees;
        this.pivotX = { position: 0, velocity: 0 };
        this.pivotY = { position: 1.45, velocity: 0 };
        this.pivotZ = { position: 0, velocity: 0 };
        this.clearanceLift = 0;
        this.secondsSinceLookInput = 100;
        this.timeSeconds = 0;
        this.position = new Float64Array(3);
        this.verticalFieldOfViewRadians = cameraPresets[PRESET_THIRD_PERSON].verticalFieldOfViewDegrees * degrees;
        this.firstPersonAmount = 0;
        this.focusDistanceMetres = 3.2;
        this.armLengthMetres = 3.2;
        this.outputYawRadians = 0;
        this.outputPitchRadians = 0;
        this.scratchPosition = new Float64Array(3);
        this.scratchEye = new Float64Array(3);
        this.presetChangeCount = 0;
        this.largestFrameMoveMetres = 0;
    }

    snapTo(controller, figure, yawRadians, pitchRadians = null) {
        this.yawRadians = yawRadians;
        this.pitchRadians = pitchRadians ?? cameraPresets[this.presetIndex].defaultPitchDegrees * degrees;
        this.pivotX.position = controller.positionX;
        this.pivotX.velocity = 0;
        this.pivotY.position = controller.positionY + cameraPresets[this.presetIndex].pivotHeightMetres;
        this.pivotY.velocity = 0;
        this.pivotZ.position = controller.positionZ;
        this.pivotZ.velocity = 0;
        this.blendElapsedSeconds = this.blendDurationSeconds;
        this.clearanceLift = 0;
        this.update(0, controller, figure, 0, 0, 0);
        this.largestFrameMoveMetres = 0;
    }

    setPreset(presetIndex, immediate = false) {
        if (presetIndex === this.presetIndex) {
            return;
        }
        const crossesFirstPerson = presetIndex === PRESET_FIRST_PERSON || this.presetIndex === PRESET_FIRST_PERSON;
        this.previousPresetIndex = this.presetIndex;
        this.presetIndex = presetIndex;
        this.blendDurationSeconds = crossesFirstPerson ? this.settings.blendSecondsIntoOrOutOfFirstPerson : this.settings.blendSecondsBetweenThirdPersonPresets;
        this.blendElapsedSeconds = immediate ? this.blendDurationSeconds : 0;
        this.presetChangeCount++;
    }

    snapToPreset(presetIndex) {
        this.presetIndex = presetIndex;
        this.previousPresetIndex = presetIndex;
        this.blendElapsedSeconds = this.blendDurationSeconds;
    }

    cyclePreset() {
        this.setPreset((this.presetIndex + 1) % cameraPresets.length);
    }

    pitchLimits(blend) {
        const from = cameraPresets[this.previousPresetIndex];
        const to = cameraPresets[this.presetIndex];
        const low = (from.pitchDownLimitDegrees + (to.pitchDownLimitDegrees - from.pitchDownLimitDegrees) * blend) * degrees;
        const high = (from.pitchUpLimitDegrees + (to.pitchUpLimitDegrees - from.pitchUpLimitDegrees) * blend) * degrees;
        return [low, high];
    }

    presetCameraPosition(preset, figure, yaw, pitch, out) {
        if (preset.firstPerson) {
            figure.eyePosition(out);
            return out;
        }
        const lookUpAmount = smoothstep(10 * degrees, preset.pitchUpLimitDegrees * degrees, pitch);
        const distance = preset.distanceMetres * (1 + (preset.lookUpDistanceScale - 1) * lookUpAmount);
        const cosinePitch = Math.cos(pitch);
        const forwardX = Math.sin(yaw) * cosinePitch;
        const forwardY = Math.sin(pitch);
        const forwardZ = Math.cos(yaw) * cosinePitch;
        const rightX = Math.cos(yaw);
        const rightZ = -Math.sin(yaw);
        const pivotHeightOffset = preset.pivotHeightMetres - cameraPresets[PRESET_THIRD_PERSON].pivotHeightMetres;
        out[0] = this.pivotX.position + rightX * preset.shoulderMetres - forwardX * distance;
        out[1] = this.pivotY.position + pivotHeightOffset + preset.verticalArmMetres - forwardY * distance;
        out[2] = this.pivotZ.position + rightZ * preset.shoulderMetres - forwardZ * distance;
        return out;
    }

    update(deltaSeconds, controller, figure, mouseDeltaX, mouseDeltaY, waterLevelMetres, recentreAllowed = true) {
        const settings = this.settings;
        const step = Math.min(Math.max(deltaSeconds, 0), 1 / 30);
        this.timeSeconds += step;
        if (step > 0) {
            this.blendElapsedSeconds = Math.min(this.blendDurationSeconds, this.blendElapsedSeconds + step);
        }
        const blend = smootherstep(this.blendElapsedSeconds / this.blendDurationSeconds);
        const from = cameraPresets[this.previousPresetIndex];
        const to = cameraPresets[this.presetIndex];
        const yawPerCount = from.yawPerCount + (to.yawPerCount - from.yawPerCount) * blend;
        const pitchPerCount = from.pitchPerCount + (to.pitchPerCount - from.pitchPerCount) * blend;
        const hasLookInput = Math.abs(mouseDeltaX) + Math.abs(mouseDeltaY) > 0;
        if (hasLookInput) {
            this.secondsSinceLookInput = 0;
        } else {
            this.secondsSinceLookInput += step;
        }
        this.yawRadians = wrapAngle(this.yawRadians + mouseDeltaX * yawPerCount);
        this.pitchRadians -= mouseDeltaY * pitchPerCount;
        const [pitchLow, pitchHigh] = this.pitchLimits(blend);
        this.pitchRadians = Math.min(pitchHigh, Math.max(pitchLow, this.pitchRadians));
        const firstPersonAmount = from.firstPerson + (to.firstPerson - from.firstPerson) * blend;
        if (step > 0 && recentreAllowed && firstPersonAmount < 0.5 && this.secondsSinceLookInput > settings.recentreDelaySeconds && controller.planarSpeed > settings.recentreMinimumSpeed) {
            const headingError = wrapAngle(controller.facingYaw - this.yawRadians);
            if (Math.abs(headingError) < settings.recentreMaximumErrorRadians) {
                const speedFactor = Math.min(1, controller.planarSpeed / 1.0);
                const easedStep = headingError * (1 - Math.exp(-step * speedFactor / settings.recentreTimeConstantSeconds));
                const maximumStep = settings.recentreMaximumRateRadiansPerSecond * step;
                this.yawRadians = wrapAngle(this.yawRadians + Math.max(-maximumStep, Math.min(maximumStep, easedStep)));
            }
            if (this.secondsSinceLookInput > settings.pitchReturnDelaySeconds) {
                const pitchTarget = to.defaultPitchDegrees * degrees;
                const pitchError = pitchTarget - this.pitchRadians;
                const easedPitch = pitchError * (1 - Math.exp(-step / settings.pitchReturnTimeConstantSeconds));
                const maximumPitchStep = settings.pitchReturnMaximumRateRadiansPerSecond * step;
                this.pitchRadians += Math.max(-maximumPitchStep, Math.min(maximumPitchStep, easedPitch));
            }
        }
        if (step > 0) {
            const leadX = controller.velocityX * settings.leadSeconds;
            const leadZ = controller.velocityZ * settings.leadSeconds;
            stepCriticallyDampedSpring(this.pivotX, controller.positionX + leadX, settings.horizontalPivotFrequency, step);
            stepCriticallyDampedSpring(this.pivotZ, controller.positionZ + leadZ, settings.horizontalPivotFrequency, step);
            stepCriticallyDampedSpring(this.pivotY, controller.positionY + cameraPresets[PRESET_THIRD_PERSON].pivotHeightMetres, settings.verticalPivotFrequency, step);
        }
        const fromPosition = this.presetCameraPosition(from, figure, this.yawRadians, this.pitchRadians, this.scratchPosition);
        const fromX = fromPosition[0];
        const fromY = fromPosition[1];
        const fromZ = fromPosition[2];
        const toPosition = this.presetCameraPosition(to, figure, this.yawRadians, this.pitchRadians, this.scratchEye);
        let positionX = fromX + (toPosition[0] - fromX) * blend;
        let positionY = fromY + (toPosition[1] - fromY) * blend;
        let positionZ = fromZ + (toPosition[2] - fromZ) * blend;
        const clearanceNeeded = Math.max(0, waterLevelMetres + settings.seaClearanceMetres - positionY) * (1 - firstPersonAmount);
        const clearanceRate = clearanceNeeded > this.clearanceLift ? settings.clearanceRiseRate : settings.clearanceRelaxRate;
        this.clearanceLift = clearanceNeeded + (this.clearanceLift - clearanceNeeded) * Math.exp(-clearanceRate * step);
        if (step === 0) {
            this.clearanceLift = clearanceNeeded;
        }
        positionY += this.clearanceLift;
        const moved = Math.hypot(positionX - this.position[0], positionY - this.position[1], positionZ - this.position[2]);
        if (step > 0 && this.timeSeconds > 0.1) {
            this.largestFrameMoveMetres = Math.max(this.largestFrameMoveMetres, moved);
        }
        this.position[0] = positionX;
        this.position[1] = positionY;
        this.position[2] = positionZ;
        const fieldOfView = from.verticalFieldOfViewDegrees + (to.verticalFieldOfViewDegrees - from.verticalFieldOfViewDegrees) * blend;
        this.verticalFieldOfViewRadians = fieldOfView * degrees;
        const lookUpFrom = smoothstep(10 * degrees, from.pitchUpLimitDegrees * degrees, this.pitchRadians);
        const lookUpTo = smoothstep(10 * degrees, to.pitchUpLimitDegrees * degrees, this.pitchRadians);
        const armFrom = from.distanceMetres * (1 + (from.lookUpDistanceScale - 1) * lookUpFrom);
        const armTo = to.distanceMetres * (1 + (to.lookUpDistanceScale - 1) * lookUpTo);
        this.armLengthMetres = armFrom + (armTo - armFrom) * blend;
        this.firstPersonAmount = firstPersonAmount;
        const swayScale = 1 + (settings.firstPersonSwayScale - 1) * firstPersonAmount;
        const swayYaw = settings.swayYawRadians * swayScale * (Math.sin(2 * Math.PI * 0.18 * this.timeSeconds) * 0.6 + Math.sin(2 * Math.PI * 0.31 * this.timeSeconds + 1.3) * 0.4);
        const swayPitch = settings.swayPitchRadians * swayScale * (Math.sin(2 * Math.PI * 0.23 * this.timeSeconds + 0.7) * 0.6 + Math.sin(2 * Math.PI * 0.37 * this.timeSeconds + 2.1) * 0.4);
        this.outputYawRadians = this.yawRadians + swayYaw;
        this.outputPitchRadians = this.pitchRadians + swayPitch;
        const helmetX = figure.world[5 * 16 + 12];
        const helmetY = figure.world[5 * 16 + 13];
        const helmetZ = figure.world[5 * 16 + 14];
        this.focusDistanceMetres = firstPersonAmount > 0.5 ? 30 : Math.hypot(helmetX - positionX, helmetY - positionY, helmetZ - positionZ);
    }
}
