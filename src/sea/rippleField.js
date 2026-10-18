import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Constants } from "@babylonjs/core/Engines/constants";
import { buildRippleKernel } from "./rippleKernel.js";
import { copyWholeTexture } from "../gpu/internals.js";

const resolution = 512;
const halfResolution = resolution / 2;
const maximumStamps = 32;
const floatsPerStamp = 12;

export const defaultRippleSettings = {
    texelMetres: 0.02,
    stepSeconds: 1 / 60,
    dampingPerSecond: 0.8,
    foamHalfLifeSeconds: 1.7,
    spongeStartFraction: 0.78,
    spongeEndFraction: 0.95,
};

function createStateTexture(scene) {
    const texture = new RawTexture(null, resolution, resolution, Constants.TEXTUREFORMAT_RGBA, scene, false, false, Constants.TEXTURE_BILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_HALF_FLOAT, Constants.TEXTURE_CREATIONFLAG_STORAGE);
    texture.wrapU = Constants.TEXTURE_WRAP_ADDRESSMODE;
    texture.wrapV = Constants.TEXTURE_WRAP_ADDRESSMODE;
    return texture;
}

export class RippleField {
    constructor({ engine, scene, profiler, seaSettings, settings = {} }) {
        this.engine = engine;
        this.profiler = profiler;
        this.settings = { ...defaultRippleSettings, ...settings };
        this.enabled = true;
        this.readTexture = createStateTexture(scene);
        this.writeTexture = createStateTexture(scene);
        this.kernel = buildRippleKernel({
            texelMetres: this.settings.texelMetres,
            depthMetres: seaSettings.meanDepthMetres,
            gravity: seaSettings.gravity,
            surfaceTensionOverDensity: seaSettings.surfaceTensionOverDensity,
        });
        this.gravity = seaSettings.gravity;
        this.kernelBuffer = new StorageBuffer(engine, this.kernel.weights.byteLength, Constants.BUFFER_CREATIONFLAG_READWRITE, "rippleKernel");
        this.kernelBuffer.update(this.kernel.weights);
        this.stampData = new Float32Array(maximumStamps * floatsPerStamp);
        this.stampBuffer = new StorageBuffer(engine, this.stampData.byteLength, Constants.BUFFER_CREATIONFLAG_READWRITE, "rippleStamps");
        this.parameters = new UniformBuffer(engine, undefined, false, "rippleStepParameters");
        for (const fieldName of ["windowLowAndPreviousLow", "updateCoefficients", "spongeAndCounts", "texelSizeAndUnused"]) {
            this.parameters.addUniform(fieldName, 4);
        }
        this.parameters.create();
        this.compute = new ComputeShader("rippleStep", engine, "rippleStep", {
            bindingsMapping: {
                parameters: { group: 0, binding: 0 },
                kernelWeights: { group: 0, binding: 1 },
                stamps: { group: 0, binding: 2 },
                previousState: { group: 0, binding: 3 },
                nextState: { group: 0, binding: 4 },
            },
        });
        this.compute.setUniformBuffer("parameters", this.parameters);
        this.compute.setStorageBuffer("kernelWeights", this.kernelBuffer);
        this.compute.setStorageBuffer("stamps", this.stampBuffer);
        this.compute.setTexture("previousState", this.readTexture, false);
        this.compute.setStorageTexture("nextState", this.writeTexture);
        this.windowLow = [0, 0];
        this.previousWindowLow = [1e6, 1e6];
        this.windowCentre = [0, 0];
        this.pendingStamps = [];
        this.pendingStampsNextStep = [];
        this.prerollSteps = 0;
        this.stepsTaken = 0;
        this.resetPending = true;
    }

    isReady() {
        return this.compute.isReady();
    }

    get halfExtentMetres() {
        return halfResolution * this.settings.texelMetres;
    }

    queueStamp(stamp) {
        if (this.pendingStamps.length < maximumStamps) {
            this.pendingStamps.push(stamp);
        }
    }

    queueStampAfterSteps(stamp, steps) {
        this.pendingStampsNextStep.push({ stamp, remainingSteps: steps });
    }

    requestReset() {
        this.resetPending = true;
    }

    requestPreroll(steps) {
        this.prerollSteps = Math.max(this.prerollSteps, steps);
    }

    updateWindow(centreX, centreZ) {
        const texel = this.settings.texelMetres;
        const centreTexelX = Math.round(centreX / texel);
        const centreTexelZ = Math.round(centreZ / texel);
        this.windowLow[0] = centreTexelX - halfResolution;
        this.windowLow[1] = centreTexelZ - halfResolution;
        this.windowCentre[0] = centreTexelX * texel;
        this.windowCentre[1] = centreTexelZ * texel;
    }

    writeStepParameters() {
        const settings = this.settings;
        const dt = settings.stepSeconds;
        const damping = settings.dampingPerSecond * dt;
        const foamKeep = Math.exp((-Math.LN2 * dt) / settings.foamHalfLifeSeconds);
        const parameters = this.parameters;
        const previous = this.resetPending ? [this.windowLow[0] + 1e6, this.windowLow[1] + 1e6] : this.previousWindowLow;
        parameters.updateFloat4("windowLowAndPreviousLow", this.windowLow[0], this.windowLow[1], previous[0], previous[1]);
        parameters.updateFloat4("updateCoefficients", (2 - damping) / (1 + damping), 1 / (1 + damping), (this.gravity * dt * dt) / (1 + damping), foamKeep);
        parameters.updateFloat4("spongeAndCounts", settings.spongeStartFraction, settings.spongeEndFraction, 0, this.pendingStamps.length);
        parameters.updateFloat4("texelSizeAndUnused", settings.texelMetres, 0, 0, 0);
        parameters.update();
        const texel = settings.texelMetres;
        const centreX = (this.windowLow[0] + halfResolution) * texel;
        const centreZ = (this.windowLow[1] + halfResolution) * texel;
        this.stampData.fill(0);
        this.pendingStamps.forEach((stamp, index) => {
            const base = index * floatsPerStamp;
            const forwardLength = Math.hypot(stamp.forwardX ?? 1, stamp.forwardZ ?? 0) || 1;
            this.stampData[base] = stamp.x - centreX;
            this.stampData[base + 1] = stamp.z - centreZ;
            this.stampData[base + 2] = stamp.radius;
            this.stampData[base + 3] = stamp.elongation ?? 1;
            this.stampData[base + 4] = (stamp.forwardX ?? 1) / forwardLength;
            this.stampData[base + 5] = (stamp.forwardZ ?? 0) / forwardLength;
            this.stampData[base + 6] = stamp.heightChange;
            this.stampData[base + 7] = stamp.foam ?? 0;
            this.stampData[base + 8] = stamp.ringWeight ?? 0.48;
        });
        this.stampBuffer.update(this.stampData);
    }

    dispatchFrame(centreX, centreZ, clockAdvanced) {
        if (!this.enabled) {
            return;
        }
        this.updateWindow(centreX, centreZ);
        const shouldStep = clockAdvanced || this.prerollSteps > 0 || this.resetPending;
        if (!shouldStep) {
            return;
        }
        for (let index = this.pendingStampsNextStep.length - 1; index >= 0; index--) {
            const delayed = this.pendingStampsNextStep[index];
            if (delayed.remainingSteps <= 0) {
                this.queueStamp(delayed.stamp);
                this.pendingStampsNextStep.splice(index, 1);
            } else {
                delayed.remainingSteps--;
            }
        }
        this.writeStepParameters();
        this.profiler.explicitLabel = "ripples";
        this.compute.dispatch(resolution / 16, resolution / 16, 1);
        this.profiler.explicitLabel = null;
        copyWholeTexture(this.engine, this.writeTexture, this.readTexture, resolution, resolution);
        this.previousWindowLow[0] = this.windowLow[0];
        this.previousWindowLow[1] = this.windowLow[1];
        this.pendingStamps.length = 0;
        this.resetPending = false;
        if (this.prerollSteps > 0) {
            this.prerollSteps--;
        }
        this.stepsTaken++;
    }
}
