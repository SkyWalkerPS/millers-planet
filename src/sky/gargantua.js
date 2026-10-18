import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Constants } from "@babylonjs/core/Engines/constants";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import {
    BLACKBODY_TABLE_SIZE,
    GargantuaUniformWriter,
    buildBlackbodyTable,
    degrees,
    observerFrame,
    orbitObserverBasis,
    pageThorneDiskModel,
    rendererAxesForUntiltedBlackHole,
    toBlackHoleFrame,
} from "./gargantuaModel.js";

const noiseWidth = 1024;
const noiseHeight = 256;
const workgroupEdge = 8;

export const defaultGargantuaSettings = {
    spin: 0.998,
    observerRadius: 30,
    observerElevationDegrees: 6,
    diskOuterRadius: 8,
    diskPeakTemperature: 14000,
    cinematicColour: true,
    maxSteps: 96,
    patchWidth: 1024,
    patchHeight: 800,
    halfAngleXDegrees: 21,
    halfAngleYDegrees: 16,
    sliceCount: 16,
    diskTimeMassPerSecond: 0.5,
    rollDegrees: 0,
};

function createStorageTexture(scene, width, height, withMipmaps, samplingMode, wrapMode) {
    const texture = new RawTexture(
        null,
        width,
        height,
        Constants.TEXTUREFORMAT_RGBA,
        scene,
        withMipmaps,
        false,
        samplingMode,
        Constants.TEXTURETYPE_HALF_FLOAT,
        Constants.TEXTURE_CREATIONFLAG_STORAGE,
    );
    texture.wrapU = wrapMode;
    texture.wrapV = wrapMode;
    return texture;
}

export class GargantuaSky {
    constructor({ engine, scene, profiler, azimuthRadians, elevationRadians, settings = {} }) {
        this.engine = engine;
        this.scene = scene;
        this.profiler = profiler;
        this.settings = { ...defaultGargantuaSettings, ...settings };
        this.azimuthRadians = azimuthRadians;
        this.elevationRadians = elevationRadians;
        this.enabled = true;
        this.debugHeatMap = false;
        this.tanHalfX = Math.tan(degrees(this.settings.halfAngleXDegrees));
        this.tanHalfY = Math.tan(degrees(this.settings.halfAngleYDegrees));
        this.uniformWriter = new GargantuaUniformWriter();
        ShaderStore.IncludesShadersStoreWGSL.gargantuaUniformStruct = this.uniformWriter.layout.wgsl;
        this.uniformBuffer = new StorageBuffer(engine, this.uniformWriter.layout.byteSize, Constants.BUFFER_CREATIONFLAG_READWRITE, "gargantuaUniforms");
        this.blackbodyTable = new RawTexture(
            buildBlackbodyTable(),
            BLACKBODY_TABLE_SIZE,
            1,
            Constants.TEXTUREFORMAT_RGBA,
            scene,
            false,
            false,
            Constants.TEXTURE_NEAREST_SAMPLINGMODE,
            Constants.TEXTURETYPE_FLOAT,
        );
        this.noiseTexture = createStorageTexture(scene, noiseWidth, noiseHeight, true, Constants.TEXTURE_TRILINEAR_SAMPLINGMODE, Constants.TEXTURE_WRAP_ADDRESSMODE);
        this.patchTextures = [0, 1, 2].map(() => createStorageTexture(scene, this.settings.patchWidth, this.settings.patchHeight, true, Constants.TEXTURE_TRILINEAR_SAMPLINGMODE, Constants.TEXTURE_CLAMP_ADDRESSMODE));
        this.sliceParameters = new UniformBuffer(engine, undefined, false, "gargantuaPatchSlice");
        this.sliceParameters.addUniform("sliceIndex", 1);
        this.sliceParameters.addUniform("sliceCount", 1);
        this.sliceParameters.addUniform("debugHeatMap", 1);
        this.sliceParameters.addUniform("unusedPadding", 1);
        this.sliceParameters.create();
        this.noiseCompute = new ComputeShader("gargantuaNoise", engine, "gargantuaNoise", {
            bindingsMapping: { noiseOutput: { group: 0, binding: 0 } },
        });
        this.noiseCompute.setStorageTexture("noiseOutput", this.noiseTexture);
        this.patchComputes = this.patchTextures.map((patchTexture, index) => {
            const compute = new ComputeShader(`gargantuaPatch${index}`, engine, "gargantuaPatch", {
                bindingsMapping: {
                    frame: { group: 0, binding: 0 },
                    diskNoiseTexture: { group: 0, binding: 2 },
                    blackbodyTable: { group: 0, binding: 3 },
                    patchOutput: { group: 0, binding: 4 },
                    patchSlice: { group: 0, binding: 5 },
                },
            });
            compute.setStorageBuffer("frame", this.uniformBuffer);
            compute.setTexture("diskNoiseTexture", this.noiseTexture, true);
            compute.setTexture("blackbodyTable", this.blackbodyTable, false);
            compute.setStorageTexture("patchOutput", patchTexture);
            compute.setUniformBuffer("patchSlice", this.sliceParameters);
            return compute;
        });
        this.selfTestCompute = null;
        this.currentIndex = 0;
        this.previousIndex = 0;
        this.writingIndex = 1;
        this.sliceIndex = 0;
        this.framesSinceCompletion = 0;
        this.updatesCompleted = 0;
        this.diskTimeMass = 0;
        this.refreshRequested = false;
        this.patchForward = new Float32Array(3);
        this.patchRight = new Float32Array(3);
        this.patchUp = new Float32Array(3);
        this.computePlacement();
        this.writeStaticUniforms();
    }

    computePlacement() {
        const cosineElevation = Math.cos(this.elevationRadians);
        const forward = [Math.sin(this.azimuthRadians) * cosineElevation, Math.sin(this.elevationRadians), Math.cos(this.azimuthRadians) * cosineElevation];
        let right = [forward[2], 0, -forward[0]];
        const rightLength = Math.hypot(right[0], right[1], right[2]);
        right = right.map((value) => value / rightLength);
        let up = [
            forward[1] * right[2] - forward[2] * right[1],
            forward[2] * right[0] - forward[0] * right[2],
            forward[0] * right[1] - forward[1] * right[0],
        ];
        const roll = degrees(this.settings.rollDegrees);
        const cosineRoll = Math.cos(roll);
        const sineRoll = Math.sin(roll);
        const rolledRight = right.map((value, axis) => value * cosineRoll + up[axis] * sineRoll);
        const rolledUp = up.map((value, axis) => value * cosineRoll - right[axis] * sineRoll);
        right = rolledRight;
        up = rolledUp;
        this.patchForward.set(forward);
        this.patchRight.set(right);
        this.patchUp.set(up);
    }

    writeStaticUniforms() {
        const settings = this.settings;
        const axes = rendererAxesForUntiltedBlackHole();
        const basis = orbitObserverBasis(settings.observerRadius, 0, degrees(settings.observerElevationDegrees));
        const positionBh = toBlackHoleFrame(axes, basis.position);
        const basisBh = { forward: toBlackHoleFrame(axes, basis.forward), right: toBlackHoleFrame(axes, basis.right), up: toBlackHoleFrame(axes, basis.up) };
        this.diskModel = pageThorneDiskModel(settings.spin);
        this.observer = observerFrame(settings.spin, positionBh);
        this.uniformWriter.writeObserver(settings.spin, this.observer, basisBh);
        this.uniformWriter.writeDisk(this.diskModel, settings.diskOuterRadius, settings.diskPeakTemperature, settings.cinematicColour);
        this.uniformWriter.writeSteps(settings.maxSteps);
        this.uniformWriter.writeView(settings.patchWidth, settings.patchHeight, this.tanHalfX, this.tanHalfY);
        this.uniformWriter.set("turbulenceLoopPeriod", 0);
        this.uniformWriter.set("earlyEscape", 1);
        this.uniformWriter.set("diskTime", this.diskTimeMass);
        this.uniformBuffer.update(this.uniformWriter.data);
    }

    setDiskPeakTemperature(temperature) {
        this.settings.diskPeakTemperature = temperature;
        this.writeStaticUniforms();
    }

    get allComputeShaders() {
        return [this.noiseCompute, ...this.patchComputes];
    }

    isReady() {
        return this.allComputeShaders.every((compute) => compute.isReady());
    }

    writeSlice(sliceIndex, sliceCount) {
        this.sliceParameters.updateFloat("sliceIndex", sliceIndex);
        this.sliceParameters.updateFloat("sliceCount", sliceCount);
        this.sliceParameters.updateFloat("debugHeatMap", this.debugHeatMap ? 1 : 0);
        this.sliceParameters.update();
    }

    dispatchSlice(patchIndex, sliceIndex, sliceCount) {
        const rowsInSlice = Math.ceil(this.settings.patchHeight / sliceCount);
        this.writeSlice(sliceIndex, sliceCount);
        this.profiler.explicitLabel = "gargantuaSlice";
        this.patchComputes[patchIndex].dispatch(Math.ceil(this.settings.patchWidth / workgroupEdge), Math.ceil(rowsInSlice / workgroupEdge), 1);
        this.profiler.explicitLabel = null;
    }

    bakeNoiseAndFirstImage(simulationSeconds) {
        this.profiler.explicitLabel = "gargantuaNoise";
        this.noiseCompute.dispatch(noiseWidth / workgroupEdge, noiseHeight / workgroupEdge, 1);
        this.profiler.explicitLabel = null;
        this.engine.generateMipmaps(this.noiseTexture.getInternalTexture());
        this.diskTimeMass = simulationSeconds * this.settings.diskTimeMassPerSecond;
        this.uniformWriter.set("diskTime", this.diskTimeMass);
        this.uniformBuffer.update(this.uniformWriter.data);
        this.dispatchSlice(0, 0, 1);
        this.engine.generateMipmaps(this.patchTextures[0].getInternalTexture());
        this.currentIndex = 0;
        this.previousIndex = 0;
        this.writingIndex = 1;
        this.sliceIndex = 0;
        this.framesSinceCompletion = this.settings.sliceCount;
        this.updatesCompleted = 1;
    }

    dispatchFrameSlice(simulationSeconds) {
        if (!this.enabled) {
            return;
        }
        const sliceCount = this.settings.sliceCount;
        if (this.sliceIndex === 0) {
            this.diskTimeMass = simulationSeconds * this.settings.diskTimeMassPerSecond;
            this.uniformWriter.set("diskTime", this.diskTimeMass);
            this.uniformBuffer.update(this.uniformWriter.data);
        }
        this.dispatchSlice(this.writingIndex, this.sliceIndex, sliceCount);
        this.sliceIndex++;
        this.framesSinceCompletion++;
        if (this.sliceIndex >= sliceCount) {
            this.profiler.explicitLabel = "gargantuaMips";
            this.engine.generateMipmaps(this.patchTextures[this.writingIndex].getInternalTexture());
            this.profiler.explicitLabel = null;
            const finishedIndex = this.writingIndex;
            this.writingIndex = this.previousIndex === this.currentIndex ? 3 - this.currentIndex - finishedIndex : this.previousIndex;
            this.previousIndex = this.currentIndex;
            this.currentIndex = finishedIndex;
            this.sliceIndex = 0;
            this.framesSinceCompletion = 0;
            this.updatesCompleted++;
        }
    }

    async measureKeyLight(mipLevel = 4) {
        const settings = this.settings;
        const width = settings.patchWidth >> mipLevel;
        const height = settings.patchHeight >> mipLevel;
        const texels = await this.currentTexture.readPixels(0, mipLevel, null, true);
        const tangentStepX = (2 * this.tanHalfX) / width;
        const tangentStepY = (2 * this.tanHalfY) / height;
        const illuminance = [0, 0, 0];
        const luminanceWeightedDirection = [0, 0, 0];
        const samples = [];
        let luminanceFlux = 0;
        for (let row = 0; row < height; row++) {
            const tangentY = (1 - ((row + 0.5) / height) * 2) * this.tanHalfY;
            for (let column = 0; column < width; column++) {
                const tangentX = (((column + 0.5) / width) * 2 - 1) * this.tanHalfX;
                const base = (row * width + column) * 4;
                const red = texels[base];
                const green = texels[base + 1];
                const blue = texels[base + 2];
                const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
                if (luminance <= 0) {
                    continue;
                }
                const solidAngle = (tangentStepX * tangentStepY) / Math.pow(1 + tangentX * tangentX + tangentY * tangentY, 1.5);
                const direction = [0, 1, 2].map((axis) => this.patchForward[axis] + tangentX * this.patchRight[axis] + tangentY * this.patchUp[axis]);
                const length = Math.hypot(direction[0], direction[1], direction[2]);
                const unit = direction.map((value) => value / length);
                illuminance[0] += red * solidAngle;
                illuminance[1] += green * solidAngle;
                illuminance[2] += blue * solidAngle;
                luminanceFlux += luminance * solidAngle;
                for (let axis = 0; axis < 3; axis++) {
                    luminanceWeightedDirection[axis] += unit[axis] * luminance * solidAngle;
                }
                samples.push([unit, luminance * solidAngle]);
            }
        }
        const centroidLength = Math.hypot(...luminanceWeightedDirection);
        const centroid = luminanceWeightedDirection.map((value) => value / Math.max(centroidLength, 1e-12));
        let weightedSquaredAngle = 0;
        for (const [unit, weight] of samples) {
            const cosine = Math.min(1, unit[0] * centroid[0] + unit[1] * centroid[1] + unit[2] * centroid[2]);
            const angle = Math.acos(cosine);
            weightedSquaredAngle += angle * angle * weight;
        }
        const angularRadiusRadians = Math.sqrt(weightedSquaredAngle / Math.max(luminanceFlux, 1e-12));
        return { direction: centroid, illuminance, luminanceFlux, angularRadiusRadians };
    }

    get crossfade() {
        return Math.min(1, this.framesSinceCompletion / this.settings.sliceCount);
    }

    get currentTexture() {
        return this.patchTextures[this.currentIndex];
    }

    get previousTexture() {
        return this.patchTextures[this.previousIndex];
    }

    ensureSelfTestCompute() {
        if (this.selfTestCompute) {
            return;
        }
        this.selfTestUniformBuffer = new StorageBuffer(this.engine, this.uniformWriter.layout.byteSize, Constants.BUFFER_CREATIONFLAG_READWRITE, "gargantuaSelfTestUniforms");
        this.selfTestCompute = new ComputeShader("gargantuaSelfTest", this.engine, "gargantuaSelfTest", {
            bindingsMapping: {
                frame: { group: 0, binding: 0 },
                diskNoiseTexture: { group: 0, binding: 2 },
                blackbodyTable: { group: 0, binding: 3 },
                selfTestDirections: { group: 0, binding: 4 },
                selfTestRecords: { group: 0, binding: 5 },
            },
        });
        this.selfTestCompute.setStorageBuffer("frame", this.selfTestUniformBuffer);
        this.selfTestCompute.setTexture("diskNoiseTexture", this.noiseTexture, true);
        this.selfTestCompute.setTexture("blackbodyTable", this.blackbodyTable, false);
    }

    patchLocalDirections(columns, rows) {
        const axes = rendererAxesForUntiltedBlackHole();
        const basis = orbitObserverBasis(this.settings.observerRadius, 0, degrees(this.settings.observerElevationDegrees));
        const toBh = (vector) => toBlackHoleFrame(axes, vector);
        const forward = toBh(basis.forward);
        const right = toBh(basis.right);
        const up = toBh(basis.up);
        const directions = [];
        for (let row = 0; row < rows; row++) {
            for (let column = 0; column < columns; column++) {
                const ndcX = ((column + 0.5) / columns) * 2 - 1;
                const ndcY = 1 - ((row + 0.5) / rows) * 2;
                const direction = forward.map((value, axis) => value + ndcX * this.tanHalfX * right[axis] + ndcY * this.tanHalfY * up[axis]);
                const length = Math.hypot(direction[0], direction[1], direction[2]);
                const unit = direction.map((value) => value / length);
                directions.push([
                    unit[0] * this.observer.radialHat[0] + unit[1] * this.observer.radialHat[1] + unit[2] * this.observer.radialHat[2],
                    unit[0] * this.observer.polarHat[0] + unit[1] * this.observer.polarHat[1] + unit[2] * this.observer.polarHat[2],
                    unit[0] * this.observer.phiHat[0] + unit[1] * this.observer.phiHat[1] + unit[2] * this.observer.phiHat[2],
                ]);
            }
        }
        return directions;
    }

    preparePatchStepSurvey(columns, rows) {
        this.ensureSelfTestCompute();
        const writer = new GargantuaUniformWriter();
        writer.data.set(this.uniformWriter.data);
        this.selfTestUniformBuffer.update(writer.data);
        return this.prepareDirectionBuffers(this.patchLocalDirections(columns, rows));
    }

    prepareDirectionBuffers(directions) {
        const directionData = new Float32Array(directions.length * 4);
        directions.forEach((direction, index) => directionData.set([direction[0], direction[1], direction[2], 0], index * 4));
        const directionBuffer = new StorageBuffer(this.engine, directionData.byteLength, Constants.BUFFER_CREATIONFLAG_READWRITE, "gargantuaSelfTestDirections");
        directionBuffer.update(directionData);
        const recordBuffer = new StorageBuffer(this.engine, directions.length * 48, Constants.BUFFER_CREATIONFLAG_READWRITE, "gargantuaSelfTestRecords");
        this.selfTestCompute.setStorageBuffer("selfTestDirections", directionBuffer);
        this.selfTestCompute.setStorageBuffer("selfTestRecords", recordBuffer);
        return { directionBuffer, recordBuffer, count: directions.length };
    }

    prepareSelfTest({ spin, radius, thetaDegrees, phiDegrees, directions, maxSteps = 4000 }) {
        this.ensureSelfTestCompute();
        const writer = new GargantuaUniformWriter();
        writer.data.set(this.uniformWriter.data);
        const theta = degrees(thetaDegrees);
        const phi = degrees(phiDegrees);
        const spheroidal = Math.sqrt(radius * radius + spin * spin);
        const positionBh = [spheroidal * Math.sin(theta) * Math.cos(phi), spheroidal * Math.sin(theta) * Math.sin(phi), radius * Math.cos(theta)];
        writer.writeObserver(spin, observerFrame(spin, positionBh), { forward: [0, 0, 1], right: [1, 0, 0], up: [0, 1, 0] });
        writer.writeDisk(pageThorneDiskModel(spin), 1e9, this.settings.diskPeakTemperature, this.settings.cinematicColour);
        writer.set("diskInnerRadius", 0);
        writer.set("stepAngleNear", 0.1);
        writer.set("stepAngleFar", 0.35);
        writer.set("stepRadialSpan", 0.1);
        writer.set("maxSteps", maxSteps);
        writer.set("earlyEscape", 0);
        this.selfTestUniformBuffer.update(writer.data);
        return this.prepareDirectionBuffers(directions);
    }

    dispatchSelfTest(prepared) {
        this.selfTestCompute.dispatch(Math.ceil(prepared.count / 64), 1, 1);
    }

    static decodeSelfTestRecords(bytes, count) {
        const values = new Float32Array(bytes.buffer, bytes.byteOffset, count * 12);
        const outcomes = ["captured", "escaped", "maxsteps", "opaque"];
        const records = [];
        for (let index = 0; index < count; index++) {
            const base = index * 12;
            records.push({
                outcome: outcomes[values[base]],
                steps: values[base + 1],
                crossings: values[base + 2],
                skyRedshift: values[base + 3],
                direction: [values[base + 4], values[base + 5], values[base + 6]],
                firstCrossing: { r: values[base + 8], phi: values[base + 9], t: values[base + 10], mu: values[base + 11] },
            });
        }
        return records;
    }
}
