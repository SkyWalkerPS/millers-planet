import { Scene } from "@babylonjs/core/scene";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { createEngine } from "./engine.js";
import { SimulationClock } from "./clock.js";
import { createFramePacer } from "./pacing.js";
import { InputState } from "./input.js";
import { CameraFrame } from "./cameraFrame.js";
import { AudioSystem } from "../audio/audio.js";
import { GpuErrorCollector } from "../gpu/errors.js";
import { FrameLog, frameLogCapacity } from "../gpu/frameLog.js";
import { PassTimestampProfiler } from "../gpu/profiler.js";
import { DynamicResolutionController } from "../gpu/resolution.js";
import { BeautyTargets } from "../gpu/targets.js";
import { FrameUniforms } from "../gpu/frameUniforms.js";
import { registerAllShaders } from "../gpu/shaderRegistry.js";
import { discardCanvasDepthAfterEachPass, getGpuDevice, installPipelineCreationCounters } from "../gpu/internals.js";
import { PostChain } from "../post/postChain.js";
import { TestScene } from "../debug/testScene.js";
import { SpikeChecks } from "../debug/spike.js";
import { GargantuaSky } from "../sky/gargantua.js";
import { AtmosphereSystem } from "../sky/atmosphere.js";
import { SkyDome } from "../sky/skyDome.js";
import { temporarySkyLook } from "../sky/skyLook.js";
import { shotDefinitions, orbitCameraPose } from "../debug/shots.js";
import { directionFromAzimuthElevation, gargantuaAzimuthRadians, gargantuaElevationRadians } from "../world/skyLayout.js";

const degreesToRadians = Math.PI / 180;
const timeDilationFactor = 61362;
const cameraModeCodes = { player: 0, scripted: 1, shot: 2, debug: 3 };

const passesFullyOverwrittenEachFrame = new Set(["historyA", "historyB", "shaftMask", "shaftMarch", "composite"]);
for (let level = 0; level < 8; level++) {
    passesFullyOverwrittenEachFrame.add(`bloomDown${level}`);
    passesFullyOverwrittenEachFrame.add(`bloomUp${level}`);
}
const transparentBlack = { r: 0, g: 0, b: 0, a: 0 };

function easeInOut(fraction) {
    const clamped = Math.min(1, Math.max(0, fraction));
    return clamped * clamped * (3 - 2 * clamped);
}

export class MillersPlanetApp {
    static async boot(canvas, parameters) {
        const created = await createEngine(canvas);
        const app = new MillersPlanetApp(canvas, parameters, created);
        await app.warmUp();
        app.startLiveLoop();
        return app;
    }

    constructor(canvas, parameters, { engine, enabledFeatureNames, missingRequiredFeatures, adapter }) {
        this.canvas = canvas;
        this.parameters = parameters;
        this.engine = engine;
        this.enabledFeatureNames = enabledFeatureNames;
        this.missingRequiredFeatures = missingRequiredFeatures;
        this.adapter = adapter;
        this.device = getGpuDevice(engine);
        this.gpuErrors = new GpuErrorCollector(this.device);
        this.pipelineCounters = installPipelineCreationCounters(this.device);
        discardCanvasDepthAfterEachPass(engine);
        this.frameLog = new FrameLog();
        this.profiler = new PassTimestampProfiler(engine, this.frameLog);
        this.profiler.passDescriptorPatcher = (descriptor, label, isComputePass) => this.patchPassDescriptor(descriptor, label, isComputePass);
        registerAllShaders();

        this.scene = new Scene(engine);
        this.scene.skipPointerMovePicking = true;
        this.scene.skipFrustumClipping = true;
        this.scene.autoClear = true;
        this.scene.autoClearDepthAndStencil = true;
        this.scene.clearColor = new Color4(0, 0, 0, 0);
        for (let renderingGroupId = 0; renderingGroupId < 4; renderingGroupId++) {
            this.scene.setRenderingAutoClearDepthStencil(renderingGroupId, false);
        }

        this.clock = new SimulationClock();
        if (parameters.frozenTimeSeconds !== null) {
            this.clock.freeze(parameters.frozenTimeSeconds);
        }
        this.pacer = createFramePacer();
        this.audioSystem = new AudioSystem();
        this.input = new InputState(canvas, this.audioSystem);
        this.cameraFrame = new CameraFrame(this.scene);
        this.frameUniforms = new FrameUniforms(engine);
        this.resolution = new DynamicResolutionController();
        if (parameters.pinnedScale !== null) {
            this.resolution.pin(parameters.pinnedScale);
        }
        this.profiler.addTimedFrameListener((frameIndex, spanMilliseconds) => {
            const slot = frameIndex % frameLogCapacity;
            if (this.frameLog.frameIndexBySlot[slot] === frameIndex) {
                this.resolution.onFrameTimed(frameIndex, spanMilliseconds, this.frameLog.renderScaleBySlot[slot]);
            }
        });
        this.internalSize = new Int32Array(2);
        this.beautyTargets = new BeautyTargets(this.scene, parameters.allocationPolicy);
        this.beautyClearColour = new Color4(0, 0, 0, 0);
        this.beautyTargets.onReallocatedListeners.push((targets) => {
            this.cameraFrame.camera.outputRenderTarget = targets.multiRenderTarget;
            targets.multiRenderTarget.onClearObservable.add(() => {});
        });
        this.ensureBeautyTargets(0);
        this.cameraFrame.camera.viewport = this.beautyTargets.viewport;
        this.scene.onBeforeCameraRenderObservable.add(() => {
            this.engine.clear(this.beautyClearColour, true, true, false);
        });

        this.gargantua = new GargantuaSky({
            engine,
            scene: this.scene,
            profiler: this.profiler,
            azimuthRadians: gargantuaAzimuthRadians,
            elevationRadians: gargantuaElevationRadians,
        });
        this.gargantuaRadianceScale = temporarySkyLook.gargantuaRadianceScale;
        this.gargantuaShadowStrength = temporarySkyLook.gargantuaShadowStrength;
        this.gargantuaPatchVisible = true;
        this.gargantuaFirstFillPending = true;
        this.boundGargantuaCurrentIndex = -1;
        this.boundGargantuaPreviousIndex = -1;
        this.atmosphere = new AtmosphereSystem({ engine, scene: this.scene, profiler: this.profiler, frameUniforms: this.frameUniforms });
        this.keyLightLuminance = temporarySkyLook.keyLightLuminance;
        this.keyLightColour = [...temporarySkyLook.keyLightColour];
        this.keyLightMeasurement = null;
        this.skyDome = new SkyDome({ scene: this.scene, frameUniforms: this.frameUniforms, atmosphere: this.atmosphere });
        this.scene.onBeforeRenderObservable.add(() => {
            this.dispatchGargantuaWork();
            this.atmosphere.dispatchFrame();
        });
        this.testScene = new TestScene({ scene: this.scene, engine, frameUniforms: this.frameUniforms, profiler: this.profiler });
        this.postChain = new PostChain({ engine, scene: this.scene, beautyTargets: this.beautyTargets, profiler: this.profiler });
        this.postChain.settings.exposure = temporarySkyLook.exposure;
        this.spike = new SpikeChecks(this);

        this.keyLightDirection = new Float32Array(3);
        directionFromAzimuthElevation(gargantuaAzimuthRadians, gargantuaElevationRadians, this.keyLightDirection);
        this.keyLightAngularRadiusRadians = 8 * degreesToRadians;
        this.keyLightRadiance = [24, 21, 17];

        this.frameIndex = 0;
        this.liveLoopPausedCount = 0;
        this.lastRafTimeMilliseconds = 0;
        this.lastRenderedRafTimeMilliseconds = -1;
        this.pipelinesCreatedLastFrame = 0;
        this.pipelinesCreatedDuringMeasurement = 0;
        this.warmUpComplete = false;
        this.wavePhaseCode = 0;
        this.cameraMode = "debug";
        this.viewPreset = 0;
        this.currentShotName = null;
        this.cameraTransition = null;
        this.cameraPose = { position: [0, 1.7, -20], yawRadians: 0, pitchRadians: 0, verticalFieldOfViewRadians: 56 * degreesToRadians };
        this.systemsEnabled = {
            testPattern: true,
            testGeometry: true,
            temporalUpscale: true,
            bloom: true,
            shafts: true,
            jitter: true,
            gargantua: true,
            atmosphere: true,
        };
        for (const name of parameters.disabledSystems) {
            this.setSystemEnabled(name, false);
        }
        this.applyShot(parameters.shotName && shotDefinitions[parameters.shotName] ? parameters.shotName : "empty", false);
        engine.onResizeObservable.add(() => this.invalidateTemporalHistory());
        window.addEventListener("resize", () => engine.resize());
    }

    dispatchGargantuaWork() {
        if (this.gargantuaFirstFillPending) {
            this.gargantua.bakeNoiseAndFirstImage(this.clock.timeSeconds);
            this.gargantuaFirstFillPending = false;
            return;
        }
        this.gargantua.dispatchFrameSlice(this.clock.timeSeconds);
    }

    bindGargantuaTextures() {
        const gargantua = this.gargantua;
        if (gargantua.currentIndex === this.boundGargantuaCurrentIndex && gargantua.previousIndex === this.boundGargantuaPreviousIndex) {
            return;
        }
        for (const material of this.materialsSamplingGargantua()) {
            material.setTexture("gargantuaCurrentPatch", gargantua.currentTexture);
            material.setTexture("gargantuaPreviousPatch", gargantua.previousTexture);
        }
        this.boundGargantuaCurrentIndex = gargantua.currentIndex;
        this.boundGargantuaPreviousIndex = gargantua.previousIndex;
    }

    materialsSamplingGargantua() {
        return [this.skyDome.material];
    }

    async measureAndApplyKeyLight() {
        const measured = await this.gargantua.measureKeyLight();
        this.keyLightMeasurement = measured;
        this.keyLightDirection[0] = measured.direction[0];
        this.keyLightDirection[1] = measured.direction[1];
        this.keyLightDirection[2] = measured.direction[2];
        this.keyLightAngularRadiusRadians = measured.angularRadiusRadians;
        this.applyKeyLightIlluminance();
    }

    async setLook({ exposure, keyLightLuminance, keyLightColour, gargantuaRadianceScale, gargantuaShadowStrength, gargantua, atmosphere, clouds, post } = {}) {
        if (exposure !== undefined) {
            this.postChain.settings.exposure = exposure;
        }
        if (keyLightColour !== undefined) {
            this.keyLightColour = [keyLightColour[0], keyLightColour[1], keyLightColour[2]];
        }
        if (keyLightLuminance !== undefined) {
            this.keyLightLuminance = keyLightLuminance;
        }
        if (gargantuaRadianceScale !== undefined) {
            this.gargantuaRadianceScale = gargantuaRadianceScale;
        }
        if (gargantuaShadowStrength !== undefined) {
            this.gargantuaShadowStrength = gargantuaShadowStrength;
        }
        if (post) {
            Object.assign(this.postChain.settings, post);
        }
        if (atmosphere || clouds) {
            this.atmosphere.updateSettings(atmosphere, clouds);
        }
        if (gargantua?.diskPeakTemperature !== undefined) {
            this.gargantua.setDiskPeakTemperature(gargantua.diskPeakTemperature);
            this.gargantuaFirstFillPending = true;
            await this.renderFramesNow(1);
            await this.measureAndApplyKeyLight();
        }
        this.applyKeyLightIlluminance();
        return this.currentLook();
    }

    currentLook() {
        const { exposure, bloomAmount, shaftAmount, vignetteAmount, grainAmount, sharpenAmount } = this.postChain.settings;
        return {
            exposure,
            keyLightLuminance: this.keyLightLuminance,
            keyLightColour: [...this.keyLightColour],
            gargantua: { diskPeakTemperature: this.gargantua.settings.diskPeakTemperature },
            gargantuaRadianceScale: this.gargantuaRadianceScale,
            gargantuaShadowStrength: this.gargantuaShadowStrength,
            atmosphere: { ...this.atmosphere.settings },
            clouds: { ...this.atmosphere.cloudSettings },
            post: { bloomAmount, shaftAmount, vignetteAmount, grainAmount, sharpenAmount },
            keyLight: this.keyLightMeasurement && {
                direction: [...this.keyLightMeasurement.direction],
                illuminance: [...this.keyLightMeasurement.illuminance],
                angularRadiusDegrees: (this.keyLightMeasurement.angularRadiusRadians * 180) / Math.PI,
            },
        };
    }

    applyKeyLightIlluminance() {
        const measured = this.keyLightMeasurement;
        if (!measured) {
            return;
        }
        const colour = this.keyLightColour;
        const colourLuminance = 0.2126 * colour[0] + 0.7152 * colour[1] + 0.0722 * colour[2];
        const illuminance = colour.map((value) => (value * this.keyLightLuminance) / colourLuminance);
        this.keyLightRadiance = illuminance;
        this.atmosphere.setLight(measured.direction, illuminance);
    }

    async runGargantuaRays(prepared) {
        const deadline = performance.now() + 20000;
        while (!this.gargantua.selfTestCompute.isReady()) {
            if (performance.now() > deadline) {
                throw new Error("The Gargantua self-test compute shader never became ready");
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        this.scene.onBeforeRenderObservable.addOnce(() => this.gargantua.dispatchSelfTest(prepared));
        await this.renderFramesNow(1);
        const bytes = await prepared.recordBuffer.read();
        const records = GargantuaSky.decodeSelfTestRecords(bytes, prepared.count);
        prepared.directionBuffer.dispose();
        prepared.recordBuffer.dispose();
        return records;
    }

    async checkSkyViewIndependence({ orbitFrames = 64 } = {}) {
        const gargantua = this.gargantua;
        this.applyShot("sky-gargantua", true);
        this.clock.freeze(10);
        await this.renderFramesNow(gargantua.settings.sliceCount * 2);
        const readPatch = async () => gargantua.currentTexture.readPixels(0, 4, null, true);
        const before = await readPatch();
        const updatesBeforeOrbit = gargantua.updatesCompleted;
        const startYaw = this.cameraPose.yawRadians;
        for (let frame = 0; frame < orbitFrames; frame++) {
            this.cameraPose.yawRadians = startYaw + ((frame + 1) / orbitFrames) * Math.PI * 2;
            await this.renderFramesNow(1);
        }
        const updatesDuringOrbit = gargantua.updatesCompleted - updatesBeforeOrbit;
        const after = await readPatch();
        const updatesBeforeStill = gargantua.updatesCompleted;
        await this.renderFramesNow(orbitFrames);
        const updatesWhileStill = gargantua.updatesCompleted - updatesBeforeStill;
        let largestDifference = 0;
        let largestValue = 0;
        for (let index = 0; index < before.length; index++) {
            largestDifference = Math.max(largestDifference, Math.abs(before[index] - after[index]));
            largestValue = Math.max(largestValue, Math.abs(before[index]));
        }
        const directionAt = (seconds) => {
            this.clock.freeze(seconds);
            return { seconds, patchForward: [...gargantua.patchForward], keyLightDirection: [...this.keyLightDirection] };
        };
        const atStart = directionAt(0);
        const atTenMinutes = directionAt(600);
        this.clock.freeze(null);
        return {
            orbitFrames,
            updatesDuringOrbit,
            updatesWhileStill,
            patchLargestDifferenceAfterOrbit: largestDifference,
            patchLargestValue: largestValue,
            directionAtStart: atStart,
            directionAtTenMinutes: atTenMinutes,
            directionUnchanged: atStart.patchForward.every((value, axis) => value === atTenMinutes.patchForward[axis]) && atStart.keyLightDirection.every((value, axis) => value === atTenMinutes.keyLightDirection[axis]),
        };
    }

    async readBeautyLuminance() {
        const width = this.beautyTargets.internalWidth;
        const height = this.beautyTargets.internalHeight;
        const pixels = await this.beautyTargets.colourTexture.readPixels(0, 0, null, true, false, 0, 0, width, height);
        const luminance = new Float32Array(width * height);
        for (let index = 0; index < width * height; index++) {
            luminance[index] = 0.2126 * pixels[index * 4] + 0.7152 * pixels[index * 4 + 1] + 0.0722 * pixels[index * 4 + 2];
        }
        return { width, height, luminance };
    }

    async measureGargantuaPlacement({ renderScale = 0.5, brightnessRatio = 1.1, settleFrames = 8 } = {}) {
        const previousPin = this.resolution.pinnedScale;
        const jitterWasOn = this.systemsEnabled.jitter;
        this.resolution.pin(renderScale);
        this.setSystemEnabled("jitter", false);
        this.applyShot("sky-gargantua", true);
        await this.renderFramesNow(settleFrames);
        const withDisk = await this.readBeautyLuminance();
        this.gargantuaPatchVisible = false;
        await this.renderFramesNow(2);
        const withoutDisk = await this.readBeautyLuminance();
        this.gargantuaPatchVisible = true;
        this.setSystemEnabled("jitter", jitterWasOn);
        await this.renderFramesNow(2);
        this.resolution.pin(previousPin);
        const { width, height } = withDisk;
        const forward = this.gargantua.patchForward;
        const right = this.gargantua.patchRight;
        const up = this.gargantua.patchUp;
        const camera = this.cameraFrame.position;
        const inverse = this.cameraFrame.inverseViewProjection;
        const screenPoint = new Vector3();
        const nearPoint = new Vector3();
        let minimumHorizontal = Infinity;
        let maximumHorizontal = -Infinity;
        let minimumVertical = Infinity;
        let maximumVertical = -Infinity;
        let brightenedPixels = 0;
        const ratioThresholds = [1.02, 1.05, 1.1, 1.25, 1.5, 2, 4];
        const pixelsAboveRatio = ratioThresholds.map(() => 0);
        for (let row = 0; row < height; row++) {
            for (let column = 0; column < width; column++) {
                const index = row * width + column;
                const ratio = withDisk.luminance[index] / Math.max(withoutDisk.luminance[index], 1e-6);
                for (let thresholdIndex = 0; thresholdIndex < ratioThresholds.length; thresholdIndex++) {
                    if (ratio >= ratioThresholds[thresholdIndex]) {
                        pixelsAboveRatio[thresholdIndex]++;
                    }
                }
                if (ratio < brightnessRatio) {
                    continue;
                }
                screenPoint.set(((column + 0.5) / width) * 2 - 1, ((row + 0.5) / height) * 2 - 1, 1);
                Vector3.TransformCoordinatesToRef(screenPoint, inverse, nearPoint);
                const directionX = nearPoint.x - camera.x;
                const directionY = nearPoint.y - camera.y;
                const directionZ = nearPoint.z - camera.z;
                const along = directionX * forward[0] + directionY * forward[1] + directionZ * forward[2];
                if (along <= 0 || directionY <= 0) {
                    continue;
                }
                const horizontal = Math.atan((directionX * right[0] + directionY * right[1] + directionZ * right[2]) / along);
                const vertical = Math.atan((directionX * up[0] + directionY * up[1] + directionZ * up[2]) / along);
                minimumHorizontal = Math.min(minimumHorizontal, horizontal);
                maximumHorizontal = Math.max(maximumHorizontal, horizontal);
                minimumVertical = Math.min(minimumVertical, vertical);
                maximumVertical = Math.max(maximumVertical, vertical);
                brightenedPixels++;
            }
        }
        const centreHorizontal = Math.tan((minimumHorizontal + maximumHorizontal) / 2);
        const centreVertical = Math.tan((minimumVertical + maximumVertical) / 2);
        const centre = [0, 1, 2].map((axis) => forward[axis] + right[axis] * centreHorizontal + up[axis] * centreVertical);
        const centreLength = Math.hypot(...centre);
        const toDegrees = 180 / Math.PI;
        return {
            brightenedPixels,
            imagePixels: width * height,
            horizontalSpanDegrees: (maximumHorizontal - minimumHorizontal) * toDegrees,
            verticalSpanDegrees: (maximumVertical - minimumVertical) * toDegrees,
            centreElevationDegrees: Math.asin(centre[1] / centreLength) * toDegrees,
            centreAzimuthDegrees: Math.atan2(centre[0], centre[2]) * toDegrees,
            brightnessRatio,
            renderScale,
            pixelsAboveRatio: Object.fromEntries(ratioThresholds.map((threshold, thresholdIndex) => [threshold, pixelsAboveRatio[thresholdIndex]])),
        };
    }

    async gargantuaDiagnostics({ surveyColumns = 128, surveyRows = 100 } = {}) {
        const gargantua = this.gargantua;
        const settings = gargantua.settings;
        const width = settings.patchWidth;
        const height = settings.patchHeight;
        await this.renderFramesNow(settings.sliceCount * 2 + 2);
        const patch = gargantua.currentTexture;
        const levelZero = await patch.readPixels(0, 0, null, true);
        let borderMaximumRadiance = 0;
        let borderMinimumVisibility = 1;
        let emissiveTexels = 0;
        let minimumColumn = width;
        let maximumColumn = -1;
        let minimumRow = height;
        let maximumRow = -1;
        let shadowTexels = 0;
        for (let row = 0; row < height; row++) {
            for (let column = 0; column < width; column++) {
                const base = (row * width + column) * 4;
                const radiance = 0.2126 * levelZero[base] + 0.7152 * levelZero[base + 1] + 0.0722 * levelZero[base + 2];
                const visibility = levelZero[base + 3];
                const onBorder = row === 0 || column === 0 || row === height - 1 || column === width - 1;
                if (onBorder) {
                    borderMaximumRadiance = Math.max(borderMaximumRadiance, radiance);
                    borderMinimumVisibility = Math.min(borderMinimumVisibility, visibility);
                }
                if (radiance > 0.01 || visibility < 0.99) {
                    emissiveTexels++;
                    minimumColumn = Math.min(minimumColumn, column);
                    maximumColumn = Math.max(maximumColumn, column);
                    minimumRow = Math.min(minimumRow, row);
                    maximumRow = Math.max(maximumRow, row);
                }
                if (visibility < 0.05 && radiance < 0.01) {
                    shadowTexels++;
                }
            }
        }
        const angleOfColumn = (column) => (Math.atan(((column + 0.5) / width * 2 - 1) * gargantua.tanHalfX) * 180) / Math.PI;
        const angleOfRow = (row) => (Math.atan((1 - (row + 0.5) / height * 2) * gargantua.tanHalfY) * 180) / Math.PI;
        const mipLevel = 5;
        const mipWidth = width >> mipLevel;
        const mipHeight = height >> mipLevel;
        const levelFive = await patch.readPixels(0, mipLevel, null, true);
        let largestMipError = 0;
        let largestMipValue = 0;
        for (let mipRow = 0; mipRow < mipHeight; mipRow++) {
            for (let mipColumn = 0; mipColumn < mipWidth; mipColumn++) {
                for (let channel = 0; channel < 4; channel++) {
                    let sum = 0;
                    for (let row = mipRow * 32; row < mipRow * 32 + 32; row++) {
                        for (let column = mipColumn * 32; column < mipColumn * 32 + 32; column++) {
                            sum += levelZero[(row * width + column) * 4 + channel];
                        }
                    }
                    const boxAverage = sum / 1024;
                    const mipValue = levelFive[(mipRow * mipWidth + mipColumn) * 4 + channel];
                    largestMipError = Math.max(largestMipError, Math.abs(mipValue - boxAverage));
                    largestMipValue = Math.max(largestMipValue, Math.abs(boxAverage));
                }
            }
        }
        const survey = await this.runGargantuaRays(gargantua.preparePatchStepSurvey(surveyColumns, surveyRows));
        const steps = survey.map((record) => record.steps).sort((first, second) => first - second);
        const limitHits = survey.filter((record) => record.outcome === "maxsteps").length;
        return {
            patch: [width, height],
            halfAnglesDegrees: [settings.halfAngleXDegrees, settings.halfAngleYDegrees],
            border: { maximumRadiance: borderMaximumRadiance, minimumVisibility: borderMinimumVisibility },
            imageBoxDegrees: emissiveTexels === 0 ? null : {
                left: angleOfColumn(minimumColumn), right: angleOfColumn(maximumColumn), top: angleOfRow(minimumRow), bottom: angleOfRow(maximumRow),
                width: angleOfColumn(maximumColumn) - angleOfColumn(minimumColumn), height: angleOfRow(minimumRow) - angleOfRow(maximumRow),
            },
            shadowFraction: shadowTexels / (width * height),
            mipLevelFive: { size: [mipWidth, mipHeight], largestErrorAgainstBoxAverage: largestMipError, largestValue: largestMipValue },
            stepSurvey: {
                rays: survey.length,
                mean: steps.reduce((sum, value) => sum + value, 0) / steps.length,
                p50: steps[Math.floor(steps.length * 0.5)],
                p95: steps[Math.floor(steps.length * 0.95)],
                maximum: steps[steps.length - 1],
                stepLimitFraction: limitHits / survey.length,
                overSupersampleThresholdFraction: survey.filter((record) => record.steps > 45).length / survey.length,
            },
        };
    }

    async traceGargantuaTestRays(specification) {
        return this.runGargantuaRays(this.gargantua.prepareSelfTest(specification));
    }

    patchPassDescriptor(descriptor, label, isComputePass) {
        if (isComputePass) {
            return;
        }
        if (label === "beauty") {
            if (descriptor.depthStencilAttachment) {
                descriptor.depthStencilAttachment.depthStoreOp = "discard";
            }
            return;
        }
        if (passesFullyOverwrittenEachFrame.has(label)) {
            const attachments = descriptor.colorAttachments;
            for (let attachmentIndex = 0; attachmentIndex < attachments.length; attachmentIndex++) {
                const attachment = attachments[attachmentIndex];
                if (attachment && attachment.loadOp === "load") {
                    attachment.loadOp = "clear";
                    attachment.clearValue = transparentBlack;
                }
            }
            const depthAttachment = descriptor.depthStencilAttachment;
            if (depthAttachment && depthAttachment.depthLoadOp === "load") {
                depthAttachment.depthLoadOp = "clear";
                depthAttachment.depthClearValue = 0;
            }
        }
    }

    ensureBeautyTargets(nowMilliseconds) {
        const outputWidth = this.engine.getRenderWidth();
        const outputHeight = this.engine.getRenderHeight();
        this.resolution.internalSize(outputWidth, outputHeight, this.internalSize);
        this.beautyTargets.ensure(outputWidth, outputHeight, this.internalSize[0], this.internalSize[1], nowMilliseconds);
    }

    setSystemEnabled(name, enabled) {
        if (!(name in this.systemsEnabled)) {
            throw new Error(`Unknown system ${name}`);
        }
        this.systemsEnabled[name] = Boolean(enabled);
        const isOn = Boolean(enabled);
        if (name === "testPattern") {
            this.testScene.patternEnabled = isOn;
        } else if (name === "testGeometry") {
            this.testScene.setGeometryVisible(isOn);
        } else if (name === "temporalUpscale") {
            this.postChain.settings.temporalUpscaleEnabled = isOn;
        } else if (name === "bloom") {
            this.postChain.settings.bloomEnabled = isOn;
        } else if (name === "shafts") {
            this.postChain.settings.shaftsEnabled = isOn;
        } else if (name === "jitter") {
            this.cameraFrame.jitterEnabled = isOn;
        } else if (name === "gargantua") {
            this.gargantua.enabled = isOn;
        } else if (name === "atmosphere") {
            this.atmosphere.enabled = isOn;
        }
    }

    applyShot(name, freezeTime = true) {
        const definition = shotDefinitions[name];
        if (!definition) {
            throw new Error(`Unknown shot ${name}`);
        }
        const pose = definition.pose();
        this.cameraPose.position[0] = pose.position[0];
        this.cameraPose.position[1] = pose.position[1];
        this.cameraPose.position[2] = pose.position[2];
        this.cameraPose.yawRadians = pose.yawRadians;
        this.cameraPose.pitchRadians = pose.pitchRadians;
        this.cameraPose.verticalFieldOfViewRadians = definition.verticalFieldOfViewDegrees * degreesToRadians;
        this.cameraTransition = null;
        this.cameraMode = "shot";
        this.currentShotName = name;
        const hiddenSystems = definition.hiddenSystems ?? [];
        this.setSystemEnabled("testGeometry", !hiddenSystems.includes("testGeometry"));
        for (const systemName of hiddenSystems) {
            this.setSystemEnabled(systemName, false);
        }
        if (freezeTime) {
            this.clock.freeze(definition.timeSeconds);
        }
        this.invalidateTemporalHistory();
        return { name, crop: {} };
    }

    invalidateTemporalHistory() {
        this.cameraFrame.discardHistory();
        this.postChain.historyValid = false;
    }

    setOrbitCamera(options) {
        const pose = orbitCameraPose(options);
        const transitionSeconds = options.transitionSeconds ?? 0;
        if (transitionSeconds > 0) {
            this.cameraTransition = {
                fromPosition: this.cameraPose.position.slice(),
                fromYaw: this.cameraPose.yawRadians,
                fromPitch: this.cameraPose.pitchRadians,
                toPosition: pose.position,
                toYaw: pose.yawRadians,
                toPitch: pose.pitchRadians,
                elapsedSeconds: 0,
                durationSeconds: transitionSeconds,
            };
        } else {
            this.cameraTransition = null;
            this.cameraPose.position[0] = pose.position[0];
            this.cameraPose.position[1] = pose.position[1];
            this.cameraPose.position[2] = pose.position[2];
            this.cameraPose.yawRadians = pose.yawRadians;
            this.cameraPose.pitchRadians = pose.pitchRadians;
        }
        if (options.verticalFieldOfViewDegrees) {
            this.cameraPose.verticalFieldOfViewRadians = options.verticalFieldOfViewDegrees * degreesToRadians;
        }
        this.cameraMode = "debug";
        this.currentShotName = null;
    }

    updateCamera(deltaSeconds) {
        const transition = this.cameraTransition;
        if (transition) {
            transition.elapsedSeconds += deltaSeconds;
            const blend = easeInOut(transition.elapsedSeconds / transition.durationSeconds);
            for (let axis = 0; axis < 3; axis++) {
                this.cameraPose.position[axis] = transition.fromPosition[axis] + (transition.toPosition[axis] - transition.fromPosition[axis]) * blend;
            }
            let yawDifference = transition.toYaw - transition.fromYaw;
            yawDifference = Math.atan2(Math.sin(yawDifference), Math.cos(yawDifference));
            this.cameraPose.yawRadians = transition.fromYaw + yawDifference * blend;
            this.cameraPose.pitchRadians = transition.fromPitch + (transition.toPitch - transition.fromPitch) * blend;
            if (transition.elapsedSeconds >= transition.durationSeconds) {
                this.cameraTransition = null;
            }
        }
        const pose = this.cameraPose;
        this.cameraFrame.setPose(pose.position[0], pose.position[1], pose.position[2], pose.yawRadians, pose.pitchRadians);
        this.cameraFrame.setVerticalFieldOfView(pose.verticalFieldOfViewRadians);
    }

    writeFrameUniforms(outputWidth, outputHeight, deltaSeconds) {
        const uniforms = this.frameUniforms;
        const cameraFrame = this.cameraFrame;
        uniforms.setMatrix("jitteredViewProjection", cameraFrame.jitteredViewProjection);
        uniforms.setMatrix("viewProjection", cameraFrame.viewProjection);
        uniforms.setMatrix("previousViewProjection", cameraFrame.previousViewProjection);
        uniforms.setMatrix("inverseViewProjection", cameraFrame.inverseViewProjection);
        uniforms.setMatrix("view", cameraFrame.viewMatrix);
        const position = cameraFrame.position;
        const previousPosition = cameraFrame.previousPosition;
        uniforms.setVector("cameraPositionAndTime", position.x, position.y, position.z, this.clock.timeSeconds);
        uniforms.setVector("previousCameraPositionAndDeltaTime", previousPosition.x, previousPosition.y, previousPosition.z, deltaSeconds);
        uniforms.setVector("jitterNdcAndInternalSize", cameraFrame.jitterNdcX, cameraFrame.jitterNdcY, this.beautyTargets.internalWidth, this.beautyTargets.internalHeight);
        uniforms.setVector("outputSizeAndRenderScale", outputWidth, outputHeight, this.resolution.currentScale, this.frameIndex);
        const light = this.keyLightDirection;
        uniforms.setVector("keyLightDirectionAndAngularRadius", light[0], light[1], light[2], this.keyLightAngularRadiusRadians);
        uniforms.setVector("keyLightRadianceAndFrameIndex", this.keyLightRadiance[0], this.keyLightRadiance[1], this.keyLightRadiance[2], this.frameIndex);
        const forward = cameraFrame.forward;
        uniforms.setVector("cameraForwardAndNearPlane", forward.x, forward.y, forward.z, cameraFrame.nearPlaneMetres);
        const gargantua = this.gargantua;
        uniforms.setVector("gargantuaForwardAndTanHalfX", gargantua.patchForward[0], gargantua.patchForward[1], gargantua.patchForward[2], gargantua.tanHalfX);
        uniforms.setVector("gargantuaRightAndTanHalfY", gargantua.patchRight[0], gargantua.patchRight[1], gargantua.patchRight[2], gargantua.tanHalfY);
        uniforms.setVector("gargantuaUpAndCrossfade", gargantua.patchUp[0], gargantua.patchUp[1], gargantua.patchUp[2], gargantua.crossfade);
        uniforms.setVector("gargantuaRadianceScaleAndShadowStrength", this.gargantuaPatchVisible ? this.gargantuaRadianceScale : 0, this.gargantuaPatchVisible ? this.gargantuaShadowStrength : 1, 0, 0);
        uniforms.upload();
    }

    renderFrame(rafTimeMilliseconds, deltaSeconds) {
        const engine = this.engine;
        this.frameIndex++;
        const frameIndex = this.frameIndex;
        const pipelinesBefore = this.pipelineCounters.renderPipelinesCreated + this.pipelineCounters.computePipelinesCreated;
        this.profiler.markFrameStart(frameIndex);
        this.resolution.noteFrameSubmitted(frameIndex);
        this.clock.advance(deltaSeconds);
        engine.beginFrame();
        const outputWidth = engine.getRenderWidth();
        const outputHeight = engine.getRenderHeight();
        if (this.postChain.resize(outputWidth, outputHeight)) {
            this.invalidateTemporalHistory();
        }
        this.ensureBeautyTargets(rafTimeMilliseconds);
        this.updateCamera(this.clock.lastDeltaSeconds > 0 ? this.clock.lastDeltaSeconds : deltaSeconds);
        this.cameraFrame.prepare(outputWidth, outputHeight, this.beautyTargets.internalWidth, this.beautyTargets.internalHeight);
        this.testScene.update(this.clock.timeSeconds, frameIndex);
        this.atmosphere.setCameraPositionMetres(this.cameraFrame.position.x, this.cameraFrame.position.y, this.cameraFrame.position.z);
        this.bindGargantuaTextures();
        this.writeFrameUniforms(outputWidth, outputHeight, this.clock.lastDeltaSeconds);
        const light = this.keyLightDirection;
        const lightUv = this.cameraFrame.projectDirectionToUv(light[0], light[1], light[2]);
        const postFrame = this.postChain.frame;
        postFrame.jitterNdcX = this.cameraFrame.jitterNdcX;
        postFrame.jitterNdcY = this.cameraFrame.jitterNdcY;
        postFrame.lightUvX = lightUv[0];
        postFrame.lightUvY = lightUv[1];
        postFrame.lightOnScreen = this.cameraFrame.lightOnScreen;
        this.scene.render();
        this.postChain.render(frameIndex);
        this.frameLog.recordSubmittedFrame(frameIndex, rafTimeMilliseconds, this.resolution.currentScale, this.beautyTargets.generation, this.wavePhaseCode, cameraModeCodes[this.cameraMode] ?? 3);
        engine.endFrame();
        this.cameraFrame.finishFrame();
        this.pipelinesCreatedLastFrame = this.pipelineCounters.renderPipelinesCreated + this.pipelineCounters.computePipelinesCreated - pipelinesBefore;
        if (this.warmUpComplete) {
            this.pipelinesCreatedDuringMeasurement += this.pipelinesCreatedLastFrame;
        }
    }

    startLiveLoop() {
        const onAnimationFrame = (rafTimeMilliseconds) => {
            requestAnimationFrame(onAnimationFrame);
            this.lastRafTimeMilliseconds = rafTimeMilliseconds;
            if (this.liveLoopPausedCount > 0) {
                return;
            }
            if (!this.pacer.shouldRender(rafTimeMilliseconds)) {
                return;
            }
            const deltaSeconds = this.lastRenderedRafTimeMilliseconds < 0 ? 1 / 60 : (rafTimeMilliseconds - this.lastRenderedRafTimeMilliseconds) / 1000;
            this.lastRenderedRafTimeMilliseconds = rafTimeMilliseconds;
            this.renderFrame(rafTimeMilliseconds, deltaSeconds);
        };
        requestAnimationFrame(onAnimationFrame);
    }

    async waitForGpuTimings(timeoutMilliseconds = 3000) {
        await this.device.queue.onSubmittedWorkDone();
        const deadline = performance.now() + timeoutMilliseconds;
        while (this.profiler.hasOutstandingReadbacks && performance.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 4));
        }
    }

    async renderFramesNow(count, { at = null, dt = 1 / 60 } = {}) {
        this.liveLoopPausedCount++;
        try {
            if (at !== null && at !== undefined) {
                this.clock.freeze(at);
            }
            for (let frameNumber = 0; frameNumber < count; frameNumber++) {
                this.renderFrame(performance.now(), dt);
                if (frameNumber % 2 === 1) {
                    await this.device.queue.onSubmittedWorkDone();
                }
            }
            await this.waitForGpuTimings();
        } finally {
            this.liveLoopPausedCount--;
            this.pacer.reset();
            this.lastRenderedRafTimeMilliseconds = -1;
        }
        return {
            frameIndex: this.frameIndex,
            gpu: { spanMs: this.profiler.lastSpanMilliseconds, busyMs: this.profiler.lastBusyMilliseconds, passes: this.profiler.lastPassMillisecondsObject() },
            renderScale: this.resolution.currentScale,
            internal: [this.beautyTargets.internalWidth, this.beautyTargets.internalHeight],
        };
    }

    async waitUntilFrameIndex(targetFrameIndex, timeoutMilliseconds) {
        const deadline = performance.now() + timeoutMilliseconds;
        while (this.frameIndex < targetFrameIndex) {
            if (performance.now() > deadline) {
                throw new Error(`Timed out waiting for frame ${targetFrameIndex} (at ${this.frameIndex})`);
            }
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
    }

    async benchmark({ frames = 600, warmup = 60, paced = true } = {}) {
        const framesSubmittedBefore = this.profiler.framesSubmitted;
        let firstMeasuredFrameIndex;
        let lastMeasuredFrameIndex;
        if (paced) {
            const startFrameIndex = this.frameIndex;
            await this.waitUntilFrameIndex(startFrameIndex + warmup, warmup * 100 + 5000);
            this.pipelinesCreatedDuringMeasurement = 0;
            firstMeasuredFrameIndex = this.frameIndex + 1;
            await this.waitUntilFrameIndex(firstMeasuredFrameIndex + frames - 1, frames * 100 + 5000);
            lastMeasuredFrameIndex = firstMeasuredFrameIndex + frames - 1;
        } else {
            this.liveLoopPausedCount++;
            try {
                for (let frameNumber = 0; frameNumber < warmup + frames; frameNumber++) {
                    if (frameNumber === warmup) {
                        this.pipelinesCreatedDuringMeasurement = 0;
                        firstMeasuredFrameIndex = this.frameIndex + 1;
                    }
                    this.renderFrame(performance.now(), 1 / 60);
                    if (frameNumber % 2 === 1) {
                        await this.device.queue.onSubmittedWorkDone();
                    }
                }
                lastMeasuredFrameIndex = this.frameIndex;
            } finally {
                this.liveLoopPausedCount--;
                this.pacer.reset();
                this.lastRenderedRafTimeMilliseconds = -1;
            }
        }
        const pipelinesCreated = this.pipelinesCreatedDuringMeasurement;
        await this.waitForGpuTimings(5000);
        const exported = this.frameLog.exportSince(firstMeasuredFrameIndex - 1, this.profiler.labelNames);
        const keep = exported.frameIndex.map((frameIndex) => frameIndex <= lastMeasuredFrameIndex);
        const filter = (values) => values.filter((value, index) => keep[index]);
        const rafTimes = filter(exported.rafTimeMs);
        const passMs = filter(exported.passMs);
        const passes = {};
        exported.labelNames.forEach((label, labelIndex) => {
            passes[label] = passMs.map((row) => row[labelIndex]);
        });
        const measuredFrameCount = lastMeasuredFrameIndex - firstMeasuredFrameIndex + 1;
        return {
            paced,
            framesRequested: frames,
            framesMeasured: measuredFrameCount,
            framesTimed: rafTimes.length,
            untimedFrames: measuredFrameCount - rafTimes.length,
            frameIndex: filter(exported.frameIndex),
            spans: filter(exported.gpuSpanMs),
            busy: filter(exported.gpuBusyMs),
            passes,
            scale: filter(exported.scale),
            generation: filter(exported.generation),
            intervals: rafTimes.slice(1).map((time, index) => time - rafTimes[index]),
            profilerFramesSubmitted: this.profiler.framesSubmitted - framesSubmittedBefore,
            profilerFramesTimedTotal: this.profiler.framesTimed,
            profilerFramesSubmittedTotal: this.profiler.framesSubmitted,
            pipelinesCreated,
            gpuErrors: this.gpuErrors.messages.slice(),
        };
    }

    async waitForAllReady(meshesWithMaterials, timeoutMilliseconds = 20000) {
        const deadline = performance.now() + timeoutMilliseconds;
        for (;;) {
            const materialsReady = meshesWithMaterials.every((mesh) => mesh.material.isReady(mesh));
            const computeReady = this.testScene.patternCompute.isReady() && this.gargantua.isReady() && this.atmosphere.isReady();
            const postReady = this.postChain.isReady();
            if (materialsReady && computeReady && postReady) {
                return;
            }
            if (performance.now() > deadline) {
                throw new Error(`Not ready after ${timeoutMilliseconds} ms: materials ${materialsReady}, compute ${computeReady}, post ${postReady}`);
            }
            await new Promise((resolve) => setTimeout(resolve, 16));
        }
    }

    async warmUp() {
        this.testScene.lateMarkerWarmed.setEnabled(true);
        await this.waitForAllReady([...this.testScene.allMeshes, this.testScene.lateMarkerWarmed, this.skyDome.mesh]);
        this.postChain.settings.outputBlack = 1;
        this.renderFrame(performance.now(), 1 / 60);
        await this.device.queue.onSubmittedWorkDone();
        await this.measureAndApplyKeyLight();
        for (let frameNumber = 0; frameNumber < 4; frameNumber++) {
            this.renderFrame(performance.now(), 1 / 60);
            await this.device.queue.onSubmittedWorkDone();
        }
        this.testScene.patternCompute.fastMode = true;
        this.testScene.lateMarkerWarmed.setEnabled(false);
        this.postChain.settings.outputBlack = 0;
        await this.waitForGpuTimings();
        this.warmUpComplete = true;
        this.pipelinesCreatedDuringMeasurement = 0;
        if (this.parameters.frozenTimeSeconds === null) {
            this.clock.freeze(null);
            this.clock.jumpTo(0);
        }
    }

    formatClocks() {
        const millerSeconds = this.clock.timeSeconds;
        const earthSeconds = millerSeconds * timeDilationFactor;
        return { millerSeconds, earthSeconds };
    }

    stats() {
        const profiler = this.profiler;
        const cameraFrame = this.cameraFrame;
        const clocks = this.formatClocks();
        return {
            frameIndex: this.frameIndex,
            gpu: {
                source: profiler.source,
                passNames: profiler.labelNames.slice(),
                lastSpanMs: profiler.lastSpanMilliseconds,
                lastBusyMs: profiler.lastBusyMilliseconds,
                lastPassMs: profiler.lastPassMillisecondsObject(),
                quantizedSuspect: profiler.quantizedSuspect,
                timestampGcdNanoseconds: profiler.timestampGreatestCommonDivisorNanoseconds,
                timestampFramesExamined: profiler.quantizationFramesExamined,
                framesSubmitted: profiler.framesSubmitted,
                framesTimed: profiler.framesTimed,
                framesWithoutFreeReadback: profiler.framesWithoutFreeReadback,
                passesBeyondCapacity: profiler.passesBeyondCapacity,
                maximumBeautyPassesInOneFrame: profiler.maximumBeautyPassesInOneFrame,
            },
            gpuErrors: this.gpuErrors.messages.slice(),
            pipelinesCreated: this.pipelinesCreatedLastFrame,
            pipelinesCreatedSinceWarmUp: this.pipelinesCreatedDuringMeasurement,
            output: [this.engine.getRenderWidth(), this.engine.getRenderHeight()],
            internal: [this.beautyTargets.internalWidth, this.beautyTargets.internalHeight],
            allocated: [this.beautyTargets.allocatedWidth, this.beautyTargets.allocatedHeight],
            renderScale: this.resolution.currentScale,
            renderTargetGeneration: this.beautyTargets.generation,
            renderTargetReallocations: this.beautyTargets.reallocationCount,
            allocationPolicy: this.beautyTargets.allocationPolicy,
            controller: {
                pinned: this.resolution.pinnedScale,
                decisions: this.resolution.decisionCount,
                stepUps: this.resolution.stepUpCount,
                stepDowns: this.resolution.stepDownCount,
                spikeCuts: this.resolution.spikeCutCount,
                preemptiveCuts: this.resolution.preemptiveCutCount,
                probes: this.resolution.probeCount,
                lastReason: this.resolution.lastDecisionReason,
            },
            adapter: { ...this.adapter },
            features: this.enabledFeatureNames.slice(),
            missingFeatures: this.missingRequiredFeatures.slice(),
            deviceLost: this.gpuErrors.deviceLost,
            simTime: this.clock.timeSeconds,
            timeFrozen: this.clock.isFrozen,
            wave: {
                index: 0,
                phase: "calm",
                secondsIntoPhase: this.clock.timeSeconds,
                schedule: { firstImpact: 300, period: 300, mountainsLead: 60, braceLead: 8, underwater: 5, drain: 6 },
                impactPosition: null,
                distanceMetres: null,
            },
            ship: { state: 0, position: null, tiltDegrees: 0, visible: false },
            astronaut: { position: null, headingDegrees: 0, horizontalSpeed: 0, braced: false, inputLocked: false, wetness: 0 },
            feet: [],
            camera: {
                preset: this.viewPreset,
                mode: this.cameraMode,
                shot: this.currentShotName,
                yawDegrees: (cameraFrame.yawRadians * 180) / Math.PI,
                pitchDegrees: (cameraFrame.pitchRadians * 180) / Math.PI,
                distance: null,
                fovDegrees: (cameraFrame.verticalFieldOfViewRadians * 180) / Math.PI,
                position: [cameraFrame.position.x, cameraFrame.position.y, cameraFrame.position.z],
            },
            clocks: { millerSeconds: clocks.millerSeconds, earthSeconds: clocks.earthSeconds, millerText: null, earthText: null },
            audio: { state: this.audioSystem.state, muffleCutoffHz: this.audioSystem.muffleCutoffHz },
            pointerLocked: this.input.pointerLocked,
            heldKeys: Array.from(this.input.heldKeyCodes),
            wheelEventsSeen: this.input.wheelEventsSeen,
            helmetRimVisible: this.postChain.settings.helmetRimAmount > 0,
            sky: {
                updatesCompleted: this.gargantua.updatesCompleted,
                sliceIndex: this.gargantua.sliceIndex,
                slicesPerRefresh: this.gargantua.settings.sliceCount,
                crossfade: this.gargantua.crossfade,
                patchDirection: Array.from(this.gargantua.patchForward),
                patchHalfAnglesDegrees: [this.gargantua.settings.halfAngleXDegrees, this.gargantua.settings.halfAngleYDegrees],
                observerRadius: this.gargantua.settings.observerRadius,
                diskOuterRadius: this.gargantua.settings.diskOuterRadius,
                diskPeakTemperature: this.gargantua.settings.diskPeakTemperature,
                spin: this.gargantua.settings.spin,
            },
            origin: { offset: [0, 0, 0], shifts: 0 },
            systems: { ...this.systemsEnabled },
        };
    }
}
