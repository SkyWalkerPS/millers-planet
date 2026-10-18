const degrees = Math.PI / 180;

export const locomotionSettings = {
    walkSpeedMetresPerSecond: 1.0,
    shiftSpeedMetresPerSecond: 1.3,
    startSpringFrequency: 6,
    stopSpringFrequency: 8,
    facingEaseRate: 7,
    walkingTurnRateRadiansPerSecond: 140 * degrees,
    shiftTurnRateRadiansPerSecond: 110 * degrees,
    turnInPlaceRateRadiansPerSecond: 100 * degrees,
    turnInPlaceStartRadians: 40 * degrees,
    turnInPlaceFinishRadians: 12 * degrees,
    turnInPlaceSpeedLimit: 0.15,
    turnSlowdownAtRightAngle: 0.55,
    reversalSpeedFraction: 0.3,
    inputDeadZone: 0.1,
    nominalWaterDepthMetres: 0.2,
};

export function wrapAngle(radians) {
    return Math.atan2(Math.sin(radians), Math.cos(radians));
}

export function stepCriticallyDampedSpring(state, target, angularFrequency, deltaSeconds) {
    const decay = Math.exp(-angularFrequency * deltaSeconds);
    const offset = state.position - target;
    const offsetRate = state.velocity + angularFrequency * offset;
    state.position = target + (offset + offsetRate * deltaSeconds) * decay;
    state.velocity = (state.velocity - angularFrequency * offsetRate * deltaSeconds) * decay;
}

export class SuitController {
    constructor({ seabedHeightAt, waterLevelAt = () => 0, settings = {} }) {
        this.settings = { ...locomotionSettings, ...settings };
        this.seabedHeightAt = seabedHeightAt;
        this.waterLevelAt = waterLevelAt;
        this.positionX = 0;
        this.positionY = seabedHeightAt(0, 0);
        this.positionZ = 0;
        this.facingYaw = 0;
        this.speedSpring = { position: 0, velocity: 0 };
        this.planarSpeed = 0;
        this.forwardAcceleration = 0;
        this.velocityX = 0;
        this.velocityZ = 0;
        this.requestedYaw = 0;
        this.requestedSpeed = 0;
        this.hasMoveInput = false;
        this.turningInPlace = false;
        this.inputLocked = false;
        this.distanceTravelled = 0;
    }

    teleport(x, z, yawRadians) {
        this.positionX = x;
        this.positionZ = z;
        this.positionY = this.seabedHeightAt(x, z);
        this.facingYaw = yawRadians;
        this.requestedYaw = yawRadians;
        this.speedSpring.position = 0;
        this.speedSpring.velocity = 0;
        this.planarSpeed = 0;
        this.velocityX = 0;
        this.velocityZ = 0;
        this.forwardAcceleration = 0;
        this.turningInPlace = false;
    }

    wadingSpeedFactor() {
        const depth = this.waterLevelAt(this.positionX, this.positionZ) - this.positionY;
        return Math.min(1, Math.max(0.45, 1 - 1.6 * (depth - this.settings.nominalWaterDepthMetres)));
    }

    update(deltaSeconds, moveRight, moveForward, shiftHeld, cameraYawRadians) {
        const settings = this.settings;
        const step = Math.min(deltaSeconds, 1 / 30);
        if (step <= 0) {
            return;
        }
        const inputMagnitude = this.inputLocked ? 0 : Math.min(1, Math.hypot(moveRight, moveForward));
        this.hasMoveInput = inputMagnitude > settings.inputDeadZone;
        if (this.hasMoveInput) {
            this.requestedYaw = cameraYawRadians + Math.atan2(moveRight, moveForward);
            const topSpeed = shiftHeld ? settings.shiftSpeedMetresPerSecond : settings.walkSpeedMetresPerSecond;
            this.requestedSpeed = inputMagnitude * topSpeed * this.wadingSpeedFactor();
        } else {
            this.requestedSpeed = 0;
        }
        const facingError = this.hasMoveInput ? wrapAngle(this.requestedYaw - this.facingYaw) : 0;
        const absoluteError = Math.abs(facingError);
        if (this.hasMoveInput && this.planarSpeed < settings.turnInPlaceSpeedLimit && absoluteError > settings.turnInPlaceStartRadians) {
            this.turningInPlace = true;
        }
        if (this.turningInPlace && (!this.hasMoveInput || absoluteError < settings.turnInPlaceFinishRadians)) {
            this.turningInPlace = false;
        }
        const shiftBlend = Math.min(1, Math.max(0, (this.planarSpeed - settings.walkSpeedMetresPerSecond) / 0.3));
        let turnRateLimit = settings.walkingTurnRateRadiansPerSecond + (settings.shiftTurnRateRadiansPerSecond - settings.walkingTurnRateRadiansPerSecond) * shiftBlend;
        if (this.turningInPlace) {
            turnRateLimit = settings.turnInPlaceRateRadiansPerSecond;
        }
        const easedTurn = facingError * (1 - Math.exp(-settings.facingEaseRate * step));
        const turnLimit = turnRateLimit * step;
        this.facingYaw = wrapAngle(this.facingYaw + Math.max(-turnLimit, Math.min(turnLimit, easedTurn)));
        let speedTarget = this.requestedSpeed;
        if (this.turningInPlace) {
            speedTarget = 0;
        } else if (absoluteError > Math.PI / 2) {
            speedTarget *= settings.reversalSpeedFraction;
        } else {
            speedTarget *= 1 + (settings.turnSlowdownAtRightAngle - 1) * (absoluteError / (Math.PI / 2));
        }
        const previousSpeed = this.planarSpeed;
        const frequency = speedTarget > this.speedSpring.position ? settings.startSpringFrequency : settings.stopSpringFrequency;
        stepCriticallyDampedSpring(this.speedSpring, speedTarget, frequency, step);
        if (this.speedSpring.position < 0) {
            this.speedSpring.position = 0;
            this.speedSpring.velocity = Math.max(0, this.speedSpring.velocity);
        }
        this.planarSpeed = this.speedSpring.position;
        this.forwardAcceleration = (this.planarSpeed - previousSpeed) / step;
        this.velocityX = Math.sin(this.facingYaw) * this.planarSpeed;
        this.velocityZ = Math.cos(this.facingYaw) * this.planarSpeed;
        this.positionX += this.velocityX * step;
        this.positionZ += this.velocityZ * step;
        this.positionY = this.seabedHeightAt(this.positionX, this.positionZ);
        this.distanceTravelled += this.planarSpeed * step;
    }
}
