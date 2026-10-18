import { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";

const matrixFieldNames = ["jitteredViewProjection", "viewProjection", "previousViewProjection", "inverseViewProjection", "view"];
const vectorFieldNames = [
    "cameraPositionAndTime",
    "previousCameraPositionAndDeltaTime",
    "jitterNdcAndInternalSize",
    "outputSizeAndRenderScale",
    "keyLightDirectionAndAngularRadius",
    "keyLightRadianceAndFrameIndex",
    "cameraForwardAndNearPlane",
    "gargantuaForwardAndTanHalfX",
    "gargantuaRightAndTanHalfY",
    "gargantuaUpAndCrossfade",
    "gargantuaRadianceScaleAndShadowStrength",
    "waveLightingAndHaze",
    "underwaterMediumAndDensity",
];

export class FrameUniforms {
    constructor(engine) {
        this.buffer = new UniformBuffer(engine, undefined, false, "frameUniforms");
        for (const name of matrixFieldNames) {
            this.buffer.addUniform(name, 16);
        }
        for (const name of vectorFieldNames) {
            this.buffer.addUniform(name, 4);
        }
        this.buffer.create();
    }

    setMatrix(name, matrix) {
        this.buffer.updateMatrix(name, matrix);
    }

    setVector(name, x, y, z, w) {
        this.buffer.updateFloat4(name, x, y, z, w);
    }

    upload() {
        this.buffer.update();
    }
}
