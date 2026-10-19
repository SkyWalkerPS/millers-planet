const degrees = Math.PI / 180;

export const locomotionSettings = {
    walkSpeedMetresPerSecond: 1.5,
    shiftSpeedMetresPerSecond: 1.95,
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

export const bodySphereHeightsMetres = [0.25, 0.95, 1.6];
export const bodySphereRadiusMetres = 0.32;

export function closestPointOnBox(box, x, y, z, out) {
    const relativeX = x - box.centre[0];
    const relativeY = y - box.centre[1];
    const relativeZ = z - box.centre[2];
    let inside = true;
    let leastPenetration = Infinity;
    let leastAxis = 0;
    let leastSign = 1;
    out[0] = box.centre[0];
    out[1] = box.centre[1];
    out[2] = box.centre[2];
    for (let axis = 0; axis < 3; axis++) {
        const direction = box.axes[axis];
        const local = relativeX * direction[0] + relativeY * direction[1] + relativeZ * direction[2];
        const half = box.halfSize[axis];
        const clamped = Math.min(half, Math.max(-half, local));
        if (Math.abs(local) > half) {
            inside = false;
        } else if (half - Math.abs(local) < leastPenetration) {
            leastPenetration = half - Math.abs(local);
            leastAxis = axis;
            leastSign = local >= 0 ? 1 : -1;
        }
        out[0] += direction[0] * clamped;
        out[1] += direction[1] * clamped;
        out[2] += direction[2] * clamped;
    }
    return { inside, leastPenetration, leastAxis, leastSign };
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
        this.obstacleBoxes = null;
        this.collisionContacts = 0;
        this.closestPoint = new Float64Array(3);
    }

    resolveObstacleCollisions() {
        const boxes = this.obstacleBoxes ? this.obstacleBoxes() : null;
        if (!boxes || boxes.length === 0) {
            return;
        }
        for (let iteration = 0; iteration < 3; iteration++) {
            let pushed = false;
            for (const box of boxes) {
                for (const heightAboveSeabed of bodySphereHeightsMetres) {
                    const pointY = this.positionY + heightAboveSeabed;
                    const contact = closestPointOnBox(box, this.positionX, pointY, this.positionZ, this.closestPoint);
                    if (contact.inside) {
                        const axis = box.axes[contact.leastAxis];
                        const horizontalLength = Math.hypot(axis[0], axis[2]);
                        if (horizontalLength < 0.2) {
                            continue;
                        }
                        const push = (contact.leastPenetration + bodySphereRadiusMetres) / horizontalLength;
                        this.positionX += axis[0] * contact.leastSign * push;
                        this.positionZ += axis[2] * contact.leastSign * push;
                        pushed = true;
                        continue;
                    }
                    const deltaX = this.positionX - this.closestPoint[0];
                    const deltaY = pointY - this.closestPoint[1];
                    const deltaZ = this.positionZ - this.closestPoint[2];
                    const distance = Math.hypot(deltaX, deltaY, deltaZ);
                    const horizontal = Math.hypot(deltaX, deltaZ);
                    if (distance >= bodySphereRadiusMetres || horizontal < 1e-4) {
                        continue;
                    }
                    const push = (bodySphereRadiusMetres - distance) * (distance / horizontal);
                    this.positionX += (deltaX / horizontal) * push;
                    this.positionZ += (deltaZ / horizontal) * push;
                    pushed = true;
                }
            }
            if (!pushed) {
                break;
            }
            this.collisionContacts++;
        }
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

    shiftOrigin(deltaX, deltaZ) {
        this.positionX -= deltaX;
        this.positionZ -= deltaZ;
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
        const shiftBlend = Math.min(1, Math.max(0, (this.planarSpeed - settings.walkSpeedMetresPerSecond) / (settings.shiftSpeedMetresPerSecond - settings.walkSpeedMetresPerSecond)));
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
        const previousX = this.positionX;
        const previousZ = this.positionZ;
        this.positionX += this.velocityX * step;
        this.positionZ += this.velocityZ * step;
        this.positionY = this.seabedHeightAt(this.positionX, this.positionZ);
        this.resolveObstacleCollisions();
        this.positionY = this.seabedHeightAt(this.positionX, this.positionZ);
        const movedX = this.positionX - previousX;
        const movedZ = this.positionZ - previousZ;
        if (this.collisionContacts > 0 && step > 0) {
            const actualSpeed = Math.hypot(movedX, movedZ) / step;
            if (actualSpeed < this.planarSpeed) {
                this.planarSpeed = actualSpeed;
                this.speedSpring.position = Math.min(this.speedSpring.position, Math.max(actualSpeed, this.speedSpring.position * 0.9));
            }
            this.collisionContacts = 0;
        }
        this.distanceTravelled += this.planarSpeed * step;
    }
}
