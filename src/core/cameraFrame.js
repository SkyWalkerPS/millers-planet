import { TargetCamera } from "@babylonjs/core/Cameras/targetCamera";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";

const maximumJitterPhaseCount = 32;

function haltonValue(index, base) {
    let fraction = 1;
    let result = 0;
    let remaining = index;
    while (remaining > 0) {
        fraction /= base;
        result += fraction * (remaining % base);
        remaining = Math.floor(remaining / base);
    }
    return result;
}

export function writeReversedInfinitePerspective(target, verticalFieldOfViewRadians, aspect, nearPlaneMetres, jitterNdcX, jitterNdcY) {
    const focalLength = 1 / Math.tan(verticalFieldOfViewRadians * 0.5);
    Matrix.FromValuesToRef(
        focalLength / aspect, 0, 0, 0,
        0, focalLength, 0, 0,
        jitterNdcX, jitterNdcY, 0, 1,
        0, 0, nearPlaneMetres, 0,
        target,
    );
    return target;
}

export class CameraFrame {
    constructor(scene) {
        this.camera = new TargetCamera("beautyCamera", new Vector3(0, 1.7, -4), scene, false);
        this.camera.minZ = 0.05;
        this.camera.maxZ = 0;
        this.camera.fov = (56 * Math.PI) / 180;
        scene.activeCamera = this.camera;
        this.verticalFieldOfViewRadians = this.camera.fov;
        this.nearPlaneMetres = 0.05;
        this.yawRadians = 0;
        this.pitchRadians = 0;
        this.position = new Vector3(0, 1.7, -4);
        this.previousPosition = new Vector3(0, 1.7, -4);
        this.forward = new Vector3(0, 0, 1);
        this.unjitteredProjection = new Matrix();
        this.jitteredProjection = new Matrix();
        this.viewMatrix = new Matrix();
        this.viewProjection = new Matrix();
        this.jitteredViewProjection = new Matrix();
        this.previousViewProjection = new Matrix();
        this.inverseViewProjection = new Matrix();
        this.originShiftTranslation = new Matrix();
        this.shiftedViewProjection = new Matrix();
        this.hasPreviousFrame = false;
        this.jitterPhaseIndex = 0;
        this.jitterNdcX = 0;
        this.jitterNdcY = 0;
        this.jitterEnabled = true;
        this.scratchPoint = new Vector3();
        this.scratchClip = new Vector3();
        this.lightUv = new Float32Array(2);
        this.lightOnScreen = 0;
    }

    setPose(positionX, positionY, positionZ, yawRadians, pitchRadians) {
        this.position.set(positionX, positionY, positionZ);
        this.yawRadians = yawRadians;
        this.pitchRadians = pitchRadians;
    }

    setVerticalFieldOfView(radians) {
        this.verticalFieldOfViewRadians = radians;
        this.camera.fov = radians;
    }

    discardHistory() {
        this.hasPreviousFrame = false;
    }

    shiftOrigin(deltaX, deltaZ) {
        this.position.x -= deltaX;
        this.position.z -= deltaZ;
        this.previousPosition.x -= deltaX;
        this.previousPosition.z -= deltaZ;
        Matrix.TranslationToRef(deltaX, 0, deltaZ, this.originShiftTranslation);
        this.originShiftTranslation.multiplyToRef(this.viewProjection, this.shiftedViewProjection);
        this.viewProjection.copyFrom(this.shiftedViewProjection);
    }

    prepare(outputWidth, outputHeight, internalWidth, internalHeight) {
        const camera = this.camera;
        camera.position.copyFrom(this.position);
        camera.rotation.set(-this.pitchRadians, this.yawRadians, 0);
        const cosinePitch = Math.cos(this.pitchRadians);
        this.forward.set(Math.sin(this.yawRadians) * cosinePitch, Math.sin(this.pitchRadians), Math.cos(this.yawRadians) * cosinePitch);
        const aspect = outputWidth / outputHeight;
        const scaleRatio = Math.max(outputWidth / internalWidth, 1);
        const phaseCount = Math.min(maximumJitterPhaseCount, Math.ceil(8 * scaleRatio * scaleRatio));
        if (this.jitterEnabled) {
            this.jitterPhaseIndex = (this.jitterPhaseIndex + 1) % phaseCount;
            const haltonX = haltonValue(this.jitterPhaseIndex + 1, 2) - 0.5;
            const haltonY = haltonValue(this.jitterPhaseIndex + 1, 3) - 0.5;
            this.jitterNdcX = (2 * haltonX) / internalWidth;
            this.jitterNdcY = (2 * haltonY) / internalHeight;
        } else {
            this.jitterNdcX = 0;
            this.jitterNdcY = 0;
        }
        writeReversedInfinitePerspective(this.unjitteredProjection, this.verticalFieldOfViewRadians, aspect, this.nearPlaneMetres, 0, 0);
        writeReversedInfinitePerspective(this.jitteredProjection, this.verticalFieldOfViewRadians, aspect, this.nearPlaneMetres, this.jitterNdcX, this.jitterNdcY);
        camera.unfreezeProjectionMatrix();
        camera.freezeProjectionMatrix(this.jitteredProjection);
        camera.computeWorldMatrix(true);
        this.viewMatrix.copyFrom(camera.getViewMatrix(true));
        if (this.hasPreviousFrame) {
            this.previousViewProjection.copyFrom(this.viewProjection);
        }
        this.viewMatrix.multiplyToRef(this.unjitteredProjection, this.viewProjection);
        this.viewMatrix.multiplyToRef(this.jitteredProjection, this.jitteredViewProjection);
        if (!this.hasPreviousFrame) {
            this.previousViewProjection.copyFrom(this.viewProjection);
            this.previousPosition.copyFrom(this.position);
            this.hasPreviousFrame = true;
        }
        this.viewProjection.invertToRef(this.inverseViewProjection);
    }

    finishFrame() {
        this.previousPosition.copyFrom(this.position);
    }

    projectDirectionToUv(directionX, directionY, directionZ) {
        const matrix = this.viewProjection.m;
        const clipX = directionX * matrix[0] + directionY * matrix[4] + directionZ * matrix[8];
        const clipY = directionX * matrix[1] + directionY * matrix[5] + directionZ * matrix[9];
        const clipW = directionX * matrix[3] + directionY * matrix[7] + directionZ * matrix[11];
        if (clipW <= 1e-4) {
            this.lightOnScreen = 0;
            return this.lightUv;
        }
        this.lightUv[0] = (clipX / clipW) * 0.5 + 0.5;
        this.lightUv[1] = (clipY / clipW) * 0.5 + 0.5;
        const margin = 0.6;
        this.lightOnScreen = this.lightUv[0] > -margin && this.lightUv[0] < 1 + margin && this.lightUv[1] > -margin && this.lightUv[1] < 1 + margin ? 1 : 0;
        return this.lightUv;
    }
}
