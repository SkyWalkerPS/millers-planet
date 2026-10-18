import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import { RawTexture3D } from "@babylonjs/core/Materials/Textures/rawTexture3D";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { Constants } from "@babylonjs/core/Engines/constants";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";

function median(values) {
    if (values.length === 0) {
        return 0;
    }
    const sorted = values.slice().sort((first, second) => first - second);
    return sorted[sorted.length >> 1];
}

function argumentOfLargest(values) {
    let best = 0;
    for (let index = 1; index < values.length; index++) {
        if (values[index] > values[best]) {
            best = index;
        }
    }
    return best;
}

async function readFloats(storageBuffer) {
    const bytes = await storageBuffer.read();
    return new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
}

async function readTexel(texture, x, y) {
    const data = await texture.readPixels(0, 0, null, true, false, x, y, 1, 1);
    return [data[0], data[1], data[2], data[3]];
}

function roundAll(values, digits = 4) {
    return values.map((value) => Number(value.toFixed(digits)));
}

export class SpikeChecks {
    constructor(app) {
        this.app = app;
        this.names = ["S0", "S0b", "S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10", "S11", "S12", "S13"];
    }

    async runAll() {
        const results = [];
        for (const name of this.names) {
            results.push(await this.run(name));
        }
        return results;
    }

    async run(name) {
        const method = this[`check${name}`];
        if (!method) {
            throw new Error(`Unknown spike check ${name}`);
        }
        const app = this.app;
        const savedPinnedScale = app.resolution.pinnedScale;
        const savedFrozen = app.clock.frozenAtSeconds;
        try {
            const outcome = await method.call(this);
            return { name, pass: Boolean(outcome.pass), details: outcome.details, fallbackUsed: outcome.fallbackUsed ?? null };
        } catch (error) {
            return { name, pass: false, details: { error: String(error?.stack ?? error) }, fallbackUsed: null };
        } finally {
            app.resolution.pin(savedPinnedScale);
            app.clock.freeze(savedFrozen);
            app.testScene.solidColourMode = 0;
            app.testScene.boxesFollowTime = true;
        }
    }

    projectToTexel(worldPosition, target) {
        const app = this.app;
        const matrix = app.cameraFrame.viewProjection.m;
        const clipX = worldPosition.x * matrix[0] + worldPosition.y * matrix[4] + worldPosition.z * matrix[8] + matrix[12];
        const clipY = worldPosition.x * matrix[1] + worldPosition.y * matrix[5] + worldPosition.z * matrix[9] + matrix[13];
        const clipW = worldPosition.x * matrix[3] + worldPosition.y * matrix[7] + worldPosition.z * matrix[11] + matrix[15];
        const ndcX = clipX / clipW;
        const ndcY = clipY / clipW;
        target.ndc = [ndcX, ndcY];
        target.uv = [ndcX * 0.5 + 0.5, ndcY * 0.5 + 0.5];
        target.texel = [Math.floor(target.uv[0] * app.beautyTargets.internalWidth), Math.floor(target.uv[1] * app.beautyTargets.internalHeight)];
        return target;
    }

    async checkS0() {
        const app = this.app;
        app.applyShot("spike-ground", true);
        app.testScene.solidColourMode = 1;
        await app.renderFramesNow(3);
        const samples = [];
        for (let frameNumber = 0; frameNumber < 6; frameNumber++) {
            await app.renderFramesNow(1);
            const expectedChannel = app.frameIndex % 3;
            const x = Math.floor(app.beautyTargets.internalWidth / 2);
            const y = Math.floor(app.beautyTargets.internalHeight / 2);
            const texel = await readTexel(app.beautyTargets.colourTexture, x, y);
            samples.push({ frameIndex: app.frameIndex, expectedChannel, dominantChannel: argumentOfLargest(texel.slice(0, 3)), colour: roundAll(texel.slice(0, 3), 3) });
        }
        app.testScene.solidColourMode = 0;
        return { pass: samples.every((sample) => sample.expectedChannel === sample.dominantChannel), details: { samples } };
    }

    async checkS0b() {
        const app = this.app;
        app.applyShot("empty", true);
        await app.renderFramesNow(60);
        const stats = app.stats();
        const passes = stats.gpu.lastPassMs;
        const exclusiveSum = Object.values(passes).reduce((sum, value) => sum + value, 0);
        const expectedLabels = ["testPattern", "beauty", "bloomDown0", "bloomUp0", "shaftMask", "shaftMarch", "composite"];
        const missing = expectedLabels.filter((label) => !(passes[label] > 0));
        const historyTimed = (passes.historyA ?? 0) + (passes.historyB ?? 0) > 0;
        const ratio = exclusiveSum / stats.gpu.lastSpanMs;
        return {
            pass: stats.gpu.source === "timestamp-query" && missing.length === 0 && historyTimed && ratio > 0.85 && ratio <= 1.0001 && stats.gpu.framesSubmitted === stats.gpu.framesTimed,
            details: { output: stats.output, spanMs: stats.gpu.lastSpanMs, exclusiveSumMs: exclusiveSum, ratio, missing, passes },
        };
    }

    async checkS1() {
        const stats = this.app.stats();
        const expectedWidth = Math.round(window.innerWidth * window.devicePixelRatio);
        const expectedHeight = Math.round(window.innerHeight * window.devicePixelRatio);
        return {
            pass: stats.output[0] === expectedWidth && stats.output[1] === expectedHeight,
            details: { output: stats.output, cssViewport: [window.innerWidth, window.innerHeight], devicePixelRatio: window.devicePixelRatio },
        };
    }

    async checkS2() {
        const app = this.app;
        app.resolution.pin(0.6);
        app.setOrbitCamera({ yawDegrees: 0, pitchDegrees: -8, distance: 14, targetHeight: 1.5, targetX: 0, targetZ: 6 });
        app.clock.freeze(10);
        const box = app.testScene.movingBoxes[0];
        app.testScene.boxesFollowTime = false;
        const startPosition = new Vector3(-2.2, 2.6, 6);
        box.mesh.position.copyFrom(startPosition);
        box.mesh.rotation.y = 0;
        await app.renderFramesNow(4);
        const projected = this.projectToTexel(startPosition, {});
        const boxTexel = await readTexel(app.beautyTargets.colourTexture, projected.texel[0], projected.texel[1]);
        const mirroredTexelY = app.beautyTargets.internalHeight - 1 - projected.texel[1];
        const mirroredTexel = await readTexel(app.beautyTargets.colourTexture, projected.texel[0], mirroredTexelY);
        const insideCorner = await readTexel(app.beautyTargets.colourTexture, app.beautyTargets.internalWidth - 2, app.beautyTargets.internalHeight - 2);
        const outsideCorner = await readTexel(app.beautyTargets.colourTexture, app.beautyTargets.allocatedWidth - 2, app.beautyTargets.allocatedHeight - 2);
        const boxLooksRed = boxTexel[0] > boxTexel[2] * 1.5;
        const mirrorLooksRed = mirroredTexel[0] > mirroredTexel[2] * 1.5;
        const movedRight = startPosition.add(new Vector3(0.25, 0, 0));
        box.mesh.position.copyFrom(movedRight);
        await app.renderFramesNow(1);
        const afterRight = this.projectToTexel(movedRight, {});
        const motionRight = await readTexel(app.beautyTargets.motionTexture, afterRight.texel[0], afterRight.texel[1]);
        const expectedRight = [(afterRight.ndc[0] - projected.ndc[0]) * 0.5, (afterRight.ndc[1] - projected.ndc[1]) * 0.5];
        const movedUp = movedRight.add(new Vector3(0, 0.25, 0));
        box.mesh.position.copyFrom(movedUp);
        await app.renderFramesNow(1);
        const afterUp = this.projectToTexel(movedUp, {});
        const motionUp = await readTexel(app.beautyTargets.motionTexture, afterUp.texel[0], afterUp.texel[1]);
        const expectedUp = [(afterUp.ndc[0] - afterRight.ndc[0]) * 0.5, (afterUp.ndc[1] - afterRight.ndc[1]) * 0.5];
        const close = (measured, expected) => Math.abs(measured - expected) <= Math.max(0.15 * Math.abs(expected), 0.0005);
        const motionMatches = close(motionRight[0], expectedRight[0]) && close(motionRight[1], expectedRight[1]) && close(motionUp[0], expectedUp[0]) && close(motionUp[1], expectedUp[1]);
        const outsideIsClear = outsideCorner.every((value) => Math.abs(value) < 1e-6);
        const insideIsDrawn = insideCorner.slice(0, 3).some((value) => value > 0.01);
        return {
            pass: boxLooksRed && !mirrorLooksRed && motionMatches && outsideIsClear && insideIsDrawn && motionRight[0] > 0 && motionUp[1] > 0,
            details: {
                internal: [app.beautyTargets.internalWidth, app.beautyTargets.internalHeight],
                allocated: [app.beautyTargets.allocatedWidth, app.beautyTargets.allocatedHeight],
                boxTexel: projected.texel,
                boxColour: roundAll(boxTexel.slice(0, 3)),
                mirroredColour: roundAll(mirroredTexel.slice(0, 3)),
                motionRight: roundAll(motionRight.slice(0, 2), 5),
                expectedRight: roundAll(expectedRight, 5),
                motionUp: roundAll(motionUp.slice(0, 2), 5),
                expectedUp: roundAll(expectedUp, 5),
                insideCorner: roundAll(insideCorner),
                outsideCorner: roundAll(outsideCorner),
            },
        };
    }

    async checkS3() {
        const app = this.app;
        const scene = app.scene;
        app.resolution.pin(0.6);
        app.applyShot("empty", true);
        const flatMaterial = new ShaderMaterial("spikeFlatMaterial", scene, { vertex: "spikeFlat", fragment: "spikeFlat" }, {
            attributes: ["position"],
            uniforms: [],
            shaderLanguage: ShaderLanguage.WGSL,
        });
        flatMaterial.backFaceCulling = false;
        const target = new RenderTargetTexture("spikeCascadeTest", { width: 256, height: 256 }, scene, {
            generateMipMaps: false,
            type: Constants.TEXTURETYPE_HALF_FLOAT,
            generateDepthBuffer: true,
            samplingMode: Constants.TEXTURE_NEAREST_SAMPLINGMODE,
        });
        target.clearColor = new Color4(0, 0, 0, 0);
        target.renderList = [app.skyDome.mesh];
        target.setMaterialForRendering(app.skyDome.mesh, flatMaterial);
        target.activeCamera = app.cameraFrame.camera;
        const corners = [[1, 1], [254, 1], [1, 254], [254, 254]];
        const results = {};
        try {
            scene.customRenderTargets.push(target);
            for (const ignoreViewport of [true, false]) {
                target.ignoreCameraViewport = ignoreViewport;
                let ready = false;
                for (let attempt = 0; attempt < 60 && !ready; attempt++) {
                    ready = flatMaterial.isReady(app.skyDome.mesh);
                    await app.renderFramesNow(1);
                }
                await app.renderFramesNow(2);
                const values = [];
                for (const [x, y] of corners) {
                    values.push(roundAll((await readTexel(target, x, y)).slice(0, 3), 3));
                }
                results[ignoreViewport ? "ignoreCameraViewport" : "followsCameraViewport"] = values;
            }
        } finally {
            const index = scene.customRenderTargets.indexOf(target);
            if (index >= 0) {
                scene.customRenderTargets.splice(index, 1);
            }
            target.dispose();
            flatMaterial.dispose();
        }
        const allDrawn = results.ignoreCameraViewport.every((colour) => colour[0] > 0.9);
        const farCornerClear = results.followsCameraViewport[3].every((value) => value === 0);
        return { pass: allDrawn && farCornerClear, details: results };
    }

    async checkS4() {
        const app = this.app;
        app.applyShot("empty", true);
        await app.renderFramesNow(10);
        const passes = app.stats().gpu.lastPassMs;
        const compositeTimed = passes.composite > 0;
        const strayMainPass = (passes.main ?? 0) > 0;
        return {
            pass: compositeTimed && !strayMainPass && app.profiler.maximumBeautyPassesInOneFrame === 1,
            details: { compositeMs: passes.composite, mainMs: passes.main ?? 0, maximumBeautyPassesInOneFrame: app.profiler.maximumBeautyPassesInOneFrame },
        };
    }

    async checkS5() {
        const app = this.app;
        app.applyShot("empty", true);
        app.beautyTargets.setAllocationPolicy("steps");
        app.resolution.pin(0.69);
        await app.renderFramesNow(2);
        const generationBefore = app.beautyTargets.generation;
        const pipelinesBefore = app.pipelineCounters.renderPipelinesCreated + app.pipelineCounters.computePipelinesCreated;
        const crossingCpuMilliseconds = [];
        const crossingSpans = [];
        const outputWidth = app.engine.getRenderWidth();
        const outputHeight = app.engine.getRenderHeight();
        for (let crossing = 0; crossing < 20; crossing++) {
            const steppedScale = crossing % 2 === 0 ? 0.8 : 0.7;
            app.resolution.pin(crossing % 2 === 0 ? 0.71 : 0.69);
            const started = performance.now();
            app.beautyTargets.allocate(Math.ceil(outputWidth * steppedScale), Math.ceil(outputHeight * steppedScale));
            const rendered = await app.renderFramesNow(1);
            crossingCpuMilliseconds.push(performance.now() - started);
            crossingSpans.push(rendered.gpu.spanMs);
            await app.renderFramesNow(2);
        }
        const reallocations = app.beautyTargets.generation - generationBefore;
        const pipelinesCreated = app.pipelineCounters.renderPipelinesCreated + app.pipelineCounters.computePipelinesCreated - pipelinesBefore;
        app.resolution.pin(0.7);
        const steppedRun = await app.benchmark({ frames: 120, warmup: 20, paced: false });
        app.beautyTargets.setAllocationPolicy("max");
        const maximumRun = await app.benchmark({ frames: 120, warmup: 20, paced: false });
        const steppedBeauty = median(steppedRun.passes.beauty ?? []);
        const maximumBeauty = median(maximumRun.passes.beauty ?? []);
        const storeCostDifference = maximumBeauty - steppedBeauty;
        return {
            pass: pipelinesCreated === 0 && reallocations >= 19,
            details: {
                reallocations,
                pipelinesCreated,
                crossingFrameWallMillisecondsMedian: median(crossingCpuMilliseconds),
                crossingSpanMedian: median(crossingSpans),
                crossingSpanMaximum: Math.max(...crossingSpans),
                beautyMedianStepped: steppedBeauty,
                beautyMedianMaximumAllocation: maximumBeauty,
                maximumAllocationExtraMilliseconds: storeCostDifference,
                spanMedianStepped: median(steppedRun.spans),
                spanMedianMaximumAllocation: median(maximumRun.spans),
                chosenPolicy: "max",
            },
            fallbackUsed: storeCostDifference > 0.1 ? "the maximum allocation costs more than 0.1 ms; consider ?allocation=steps" : null,
        };
    }

    async checkS7() {
        const app = this.app;
        const simulation = app.seaSimulation;
        app.applyShot("sea-wide", true);
        await app.renderFramesNow(4);
        const gridSize = 256;
        const comparisons = [];
        for (const [layer, level] of [[2, 6], [1, 3], [0, 8]]) {
            const levelZero = await simulation.momentTexture.readPixels(layer, 0, null, true);
            const deepLevel = await simulation.momentTexture.readPixels(layer, level, null, true);
            const levelSize = gridSize >> level;
            const blockSize = 1 << level;
            let largestError = 0;
            let largestValue = 0;
            for (let row = 0; row < levelSize; row++) {
                for (let column = 0; column < levelSize; column++) {
                    for (let channel = 0; channel < 3; channel++) {
                        let sum = 0;
                        for (let sourceRow = row * blockSize; sourceRow < (row + 1) * blockSize; sourceRow++) {
                            for (let sourceColumn = column * blockSize; sourceColumn < (column + 1) * blockSize; sourceColumn++) {
                                sum += levelZero[(sourceRow * gridSize + sourceColumn) * 4 + channel];
                            }
                        }
                        const boxAverage = sum / (blockSize * blockSize);
                        largestError = Math.max(largestError, Math.abs(deepLevel[(row * levelSize + column) * 4 + channel] - boxAverage));
                        largestValue = Math.max(largestValue, Math.abs(boxAverage));
                    }
                }
            }
            comparisons.push({ layer, level, levelSize, largestError, largestValue, pass: largestError <= 0.02 * Math.max(largestValue, 1e-6) + 1e-6 });
        }
        const mipMilliseconds = app.stats().gpu.lastPassMs.seaMips ?? null;
        return { pass: comparisons.every((comparison) => comparison.pass && comparison.largestValue > 0), details: { comparisons, mipMilliseconds, method: "per-mip view wrappers" } };
    }

    async checkS8() {
        const diagnostics = await this.app.gargantuaDiagnostics({ surveyColumns: 8, surveyRows: 8 });
        const mip = diagnostics.mipLevelFive;
        const tolerance = 0.01 * Math.max(1, mip.largestValue);
        return { pass: mip.largestErrorAgainstBoxAverage <= tolerance, details: { mipLevelFive: mip, tolerance, patch: diagnostics.patch } };
    }

    async checkS9() {
        const app = this.app;
        const scene = app.scene;
        const volumeSize = 32;
        const volume = new RawTexture3D(
            null,
            volumeSize,
            volumeSize,
            volumeSize,
            Constants.TEXTUREFORMAT_RGBA,
            scene,
            false,
            false,
            Constants.TEXTURE_NEAREST_SAMPLINGMODE,
            Constants.TEXTURETYPE_HALF_FLOAT,
            Constants.TEXTURE_CREATIONFLAG_STORAGE,
        );
        const writer = new ComputeShader("spikeVolumeWriter", app.engine, "spikeVolumeWriter", { bindingsMapping: { volumeOutput: { group: 0, binding: 0 } } });
        writer.setStorageTexture("volumeOutput", volume);
        const material = new ShaderMaterial("spikeVolumeProbe", scene, { vertex: "skyDome", fragment: "spikeVolumeProbe" }, {
            attributes: ["position"],
            uniforms: ["sliceCoordinate"],
            samplers: ["probeVolume"],
            shaderLanguage: ShaderLanguage.WGSL,
        });
        const sliceIndex = 19;
        material.setTexture("probeVolume", volume);
        material.setFloat("sliceCoordinate", (sliceIndex + 0.5) / volumeSize);
        material.backFaceCulling = false;
        material.disableDepthWrite = true;
        const mesh = new Mesh("spikeVolumeProbe", scene);
        const vertexData = new VertexData();
        vertexData.positions = [-1, -1, 0, 3, -1, 0, -1, 3, 0];
        vertexData.indices = [0, 1, 2];
        vertexData.applyToMesh(mesh);
        mesh.material = material;
        mesh.alwaysSelectAsActiveMesh = true;
        mesh.renderingGroupId = 1;
        try {
            const deadline = performance.now() + 20000;
            while (!(writer.isReady() && material.isReady(mesh))) {
                if (performance.now() > deadline) {
                    throw new Error("The S9 writer or probe material never became ready");
                }
                await app.renderFramesNow(1);
            }
            app.applyShot("sky-gargantua", true);
            app.resolution.pin(0.7);
            app.skyDome.mesh.setEnabled(false);
            scene.onBeforeRenderObservable.addOnce(() => writer.dispatch(volumeSize / 4, volumeSize / 4, volumeSize / 4));
            await app.renderFramesNow(1);
            const width = app.beautyTargets.internalWidth;
            const row = Math.floor(app.beautyTargets.internalHeight / 2);
            const samples = [];
            for (const texelIndex of [1, 9, 16, 24, 30]) {
                const column = Math.min(width - 1, Math.floor(((texelIndex + 0.5) / volumeSize) * width));
                const texel = await readTexel(app.beautyTargets.colourTexture, column, row);
                const expected = [texelIndex / 31, sliceIndex / 31, 0.25];
                const error = Math.max(...expected.map((value, channel) => Math.abs(value - texel[channel])));
                samples.push({ column, texelIndex, expected: roundAll(expected), read: roundAll(texel.slice(0, 3)), error: Number(error.toFixed(5)) });
            }
            return { pass: samples.every((sample) => sample.error < 0.01), details: { sliceIndex, samples } };
        } finally {
            app.skyDome.mesh.setEnabled(true);
            mesh.dispose();
            material.dispose();
            volume.dispose();
        }
    }

    async checkS6() {
        const app = this.app;
        const engine = app.engine;
        const results = new StorageBuffer(engine, 16 * 4, Constants.BUFFER_CREATIONFLAG_READWRITE, "spikeConstantResults");
        const makeWriter = (label) => {
            const parameters = new UniformBuffer(engine, undefined, false, `${label}Parameters`);
            parameters.addUniform("value", 1);
            parameters.addUniform("slot", 1);
            parameters.addUniform("unusedA", 1);
            parameters.addUniform("unusedB", 1);
            parameters.create();
            const shader = new ComputeShader(label, engine, "spikeConstantWriter", {
                bindingsMapping: { parameters: { group: 0, binding: 0 }, results: { group: 0, binding: 1 } },
            });
            shader.setUniformBuffer("parameters", parameters);
            shader.setStorageBuffer("results", results);
            return { parameters, shader };
        };
        const writerA = makeWriter("spikeWriterA");
        const writerB = makeWriter("spikeWriterB");
        const shared = makeWriter("spikeWriterShared");
        let readyAttempts = 0;
        while (!(writerA.shader.isReady() && writerB.shader.isReady() && shared.shader.isReady()) && readyAttempts++ < 200) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const observer = app.scene.onBeforeRenderObservable.add(() => {
            writerA.parameters.updateFloat("value", 1.5);
            writerA.parameters.updateFloat("slot", 0);
            writerA.parameters.update();
            writerA.shader.dispatch(1, 1, 1);
            writerB.parameters.updateFloat("value", 2.5);
            writerB.parameters.updateFloat("slot", 1);
            writerB.parameters.update();
            writerB.shader.dispatch(1, 1, 1);
            shared.parameters.updateFloat("value", 3.5);
            shared.parameters.updateFloat("slot", 2);
            shared.parameters.update();
            shared.shader.dispatch(1, 1, 1);
            shared.parameters.updateFloat("value", 4.5);
            shared.parameters.updateFloat("slot", 3);
            shared.parameters.update();
            shared.shader.dispatch(1, 1, 1);
        });
        try {
            await app.renderFramesNow(1);
        } finally {
            app.scene.onBeforeRenderObservable.remove(observer);
        }
        const values = Array.from(await readFloats(results)).slice(0, 4);
        results.dispose();
        return {
            pass: values[0] === 1.5 && values[1] === 2.5,
            details: { separateInstances: values.slice(0, 2), sameInstanceUpdatedTwice: values.slice(2, 4), note: "slot 2 = 3.5 and slot 3 = 4.5 means one uniform buffer updated twice per frame is safe without fastMode" },
        };
    }

    async checkS10() {
        const app = this.app;
        app.applyShot("empty", true);
        app.clock.freeze(null);
        const stallTimer = setTimeout(() => {
            const until = performance.now() + 200;
            while (performance.now() < until) {
                continue;
            }
        }, 12000);
        const submittedBefore = app.profiler.framesSubmitted;
        const result = await app.benchmark({ frames: 1800, warmup: 30, paced: true });
        clearTimeout(stallTimer);
        const ratios = result.spans.map((span, index) => result.busy[index] / span);
        const intervals = result.intervals;
        return {
            pass: result.untimedFrames === 0 && app.profiler.framesSubmitted === app.profiler.framesTimed && median(ratios) > 0.9,
            details: {
                framesMeasured: result.framesMeasured,
                untimedFrames: result.untimedFrames,
                framesSubmittedDuringRun: app.profiler.framesSubmitted - submittedBefore,
                profilerFramesSubmitted: app.profiler.framesSubmitted,
                profilerFramesTimed: app.profiler.framesTimed,
                busyOverSpanMedian: median(ratios),
                spanMedian: median(result.spans),
                spanMaximum: Math.max(...result.spans),
                longestIntervalMs: Math.max(...intervals),
                pipelinesCreated: result.pipelinesCreated,
            },
        };
    }

    async checkS11() {
        const app = this.app;
        app.applyShot("empty", true);
        const sumPipelines = async (frameCount) => {
            let total = 0;
            for (let frameNumber = 0; frameNumber < frameCount; frameNumber++) {
                await app.renderFramesNow(1);
                total += app.pipelinesCreatedLastFrame;
            }
            return total;
        };
        await sumPipelines(2);
        app.testScene.lateMarkerWarmed.setEnabled(true);
        const warmedPipelines = await sumPipelines(6);
        app.testScene.lateMarkerWarmed.setEnabled(false);
        app.testScene.lateMarkerUnwarmed.setEnabled(true);
        let unwarmedPipelines = 0;
        for (let attempt = 0; attempt < 120 && unwarmedPipelines === 0; attempt++) {
            unwarmedPipelines += await sumPipelines(1);
        }
        app.testScene.lateMarkerUnwarmed.setEnabled(false);
        return { pass: warmedPipelines === 0 && unwarmedPipelines > 0, details: { warmedMarkerPipelinesCreated: warmedPipelines, unwarmedMarkerPipelinesCreated: unwarmedPipelines } };
    }

    async checkS12() {
        const app = this.app;
        const engine = app.engine;
        const results = new StorageBuffer(engine, 4 * 4, Constants.BUFFER_CREATIONFLAG_READWRITE, "spikeHalfResults");
        const shader = new ComputeShader("spikeHalfPrecision", engine, "spikeHalfPrecision", { bindingsMapping: { results: { group: 0, binding: 0 } } });
        shader.setStorageBuffer("results", results);
        const errorsBefore = app.gpuErrors.totalErrorCount;
        const observer = app.scene.onBeforeRenderObservable.add(() => shader.dispatch(1, 1, 1));
        let attempts = 0;
        while (!shader.isReady() && attempts++ < 200) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        try {
            await app.renderFramesNow(2);
        } finally {
            app.scene.onBeforeRenderObservable.remove(observer);
        }
        const computed = (await readFloats(results))[0];
        results.dispose();
        const computeErrors = app.gpuErrors.totalErrorCount - errorsBefore;
        const halfMaterial = new ShaderMaterial("spikeHalfMaterial", app.scene, {
            vertexSource: "enable f16;\nattribute position: vec3f;\nuniform world: mat4x4f;\n@vertex\nfn main(input: VertexInputs) -> FragmentInputs {\n    vertexOutputs.position = vec4f(vertexInputs.position, 1.0);\n}\n",
            fragmentSource: "enable f16;\n@fragment\nfn main(input: FragmentInputs) -> FragmentOutputs {\n    fragmentOutputs.fragData0 = vec4f(f32(1.0h));\n    fragmentOutputs.fragData1 = vec4f(0.0);\n}\n",
        }, { attributes: ["position"], uniforms: ["world"], shaderLanguage: ShaderLanguage.WGSL });
        const mesh = CreateBox("spikeHalfMesh", { size: 0.1 }, app.scene);
        mesh.position.set(0, -50, 0);
        mesh.material = halfMaterial;
        const materialErrorsBefore = app.gpuErrors.totalErrorCount;
        try {
            for (let frameNumber = 0; frameNumber < 8 && app.gpuErrors.totalErrorCount === materialErrorsBefore; frameNumber++) {
                await app.renderFramesNow(1);
            }
        } finally {
            mesh.dispose();
            halfMaterial.dispose();
        }
        const materialErrors = app.gpuErrors.totalErrorCount - materialErrorsBefore;
        const errorSample = app.gpuErrors.messages.slice(-1)[0] ?? "";
        app.gpuErrors.clear();
        return {
            pass: computed === 2.25 && computeErrors === 0 && materialErrors > 0,
            details: { halfComputeResult: computed, computeErrors, halfMaterialErrorsReported: materialErrors, materialErrorSample: errorSample.slice(0, 160) },
        };
    }

    async checkS13() {
        const app = this.app;
        const errorsBefore = app.gpuErrors.totalErrorCount;
        const brokenMaterial = new ShaderMaterial("spikeBrokenMaterial", app.scene, {
            vertexSource: "attribute position: vec3f;\n@vertex\nfn main(input: VertexInputs) -> FragmentInputs {\n    vertexOutputs.position = vec4f(vertexInputs.position, 1.0);\n}\n",
            fragmentSource: "@fragment\nfn main(input: FragmentInputs) -> FragmentOutputs {\n    let broken: f32 = vec3f(1.0);\n    fragmentOutputs.fragData0 = vec4f(broken);\n    fragmentOutputs.fragData1 = vec4f(0.0);\n}\n",
        }, { attributes: ["position"], uniforms: [], shaderLanguage: ShaderLanguage.WGSL });
        const mesh = CreateBox("spikeBrokenMesh", { size: 0.1 }, app.scene);
        mesh.position.set(0, -50, 0);
        mesh.material = brokenMaterial;
        let materialFrames = 0;
        try {
            while (app.gpuErrors.totalErrorCount === errorsBefore && materialFrames < 10) {
                await app.renderFramesNow(1);
                materialFrames++;
            }
        } finally {
            mesh.dispose();
            brokenMaterial.dispose();
        }
        const materialErrors = app.gpuErrors.totalErrorCount - errorsBefore;
        const computeErrorsBefore = app.gpuErrors.totalErrorCount;
        const results = new StorageBuffer(app.engine, 16, Constants.BUFFER_CREATIONFLAG_READWRITE, "spikeBrokenComputeResults");
        const brokenCompute = new ComputeShader("spikeBrokenCompute", app.engine, { computeSource: "@group(0) @binding(0) var<storage, read_write> results: array<f32>;\n@compute @workgroup_size(1)\nfn main() {\n    results[0] = undefinedName;\n}\n" }, { bindingsMapping: { results: { group: 0, binding: 0 } } });
        brokenCompute.setStorageBuffer("results", results);
        const observer = app.scene.onBeforeRenderObservable.add(() => {
            try {
                brokenCompute.dispatch(1, 1, 1);
            } catch (dispatchError) {
                app.gpuErrors.messages.push(`dispatch threw: ${dispatchError}`);
                app.gpuErrors.totalErrorCount++;
            }
        });
        let computeFrames = 0;
        try {
            while (app.gpuErrors.totalErrorCount === computeErrorsBefore && computeFrames < 10) {
                await app.renderFramesNow(1);
                computeFrames++;
            }
        } finally {
            app.scene.onBeforeRenderObservable.remove(observer);
            results.dispose();
        }
        const computeErrors = app.gpuErrors.totalErrorCount - computeErrorsBefore;
        const samples = app.gpuErrors.messages.slice(-2).map((message) => message.slice(0, 160));
        app.gpuErrors.clear();
        return {
            pass: materialErrors > 0 && materialFrames <= 5 && computeErrors > 0 && computeFrames <= 5,
            details: { materialErrors, framesUntilMaterialError: materialFrames, computeErrors, framesUntilComputeError: computeFrames, samples },
        };
    }
}
