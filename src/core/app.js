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
import { ClockGauge } from "../gpu/clockGauge.js";
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
import { SeaSimulation } from "../sea/seaSimulation.js";
import { SeaSurface } from "../sea/seaSurface.js";
import { RippleField } from "../sea/rippleField.js";
import { GiantWave } from "../wave/giantWave.js";
import { UnderwaterView } from "../wave/underwaterView.js";
import { WAVE_PHASE_BRACE, createWaveState, impactSecondsOf, secondsForPhase, waveSchedule, waveStateAt, wavePhaseLetters } from "../wave/waveTimeline.js";
import { blendCameraPoseAroundPivot, braceAmountFor, createCameraBlendScratch, createWaveCameraPose, inputLockedFor, waveCameraPose, waveCameraWeight } from "../camera/waveCamera.js";
import { SceneProxies } from "../world/sceneProxies.js";
import { Lander, SHIP_STATE_INTACT, relocationForWave, shipStateNames } from "../ship/lander.js";
import { createSeabedHeightFunction } from "../sea/seabedHeight.js";
import { SuitController, bodySphereHeightsMetres, bodySphereRadiusMetres, closestPointOnBox } from "../character/suitController.js";
import { FOOT_EVENT_HEEL_STRIKE, SuitFigure } from "../character/suitFigure.js";
import { SuitRenderer } from "../character/suitRender.js";
import { BONE_HAND_LEFT, BONE_HAND_RIGHT, BONE_HELMET, BONE_NECK, BONE_PELVIS, BONE_UPPER_ARM_LEFT, BONE_UPPER_ARM_RIGHT } from "../character/suitSkeleton.js";
import { CameraRig, cameraPresets, shoulderScaleForAspect } from "../camera/cameraRig.js";
import { scriptedInputAt, scriptedWalk } from "../character/scriptedWalk.js";
import { ClockPanel, WaveCountdownPanel, createHudRow, earthSecondsPerMillerSecond, formatEarthClock, formatMillerClock } from "../hud/clocks.js";
import { MuteButton, readStoredMutedPreference } from "../hud/muteButton.js";
import { deviceHasTouch } from "../hud/touchControls.js";
import { shotDefinitions, orbitCameraPose } from "../debug/shots.js";
import { directionFromAzimuthElevation, gargantuaAzimuthRadians, gargantuaElevationRadians, openingYawRadians } from "../world/skyLayout.js";

const degreesToRadians = Math.PI / 180;
const cameraModeCodes = { player: 0, scripted: 1, shot: 2, debug: 3 };
export const worldOriginShiftDistanceMetres = 1000;
export const worldOriginShiftStepMetres = 1024;

const passesFullyOverwrittenEachFrame = new Set(["historyA", "historyB", "shaftMask", "shaftMarch", "composite"]);
for (let level = 0; level < 8; level++) {
    passesFullyOverwrittenEachFrame.add(`bloomDown${level}`);
    passesFullyOverwrittenEachFrame.add(`bloomUp${level}`);
}
const transparentBlack = { r: 0, g: 0, b: 0, a: 0 };
const helmetProxyRadiusMetres = 0.17;
const cameraJumpCosine = Math.cos(25 * degreesToRadians);
const largeCameraJumpCosine = Math.cos(60 * degreesToRadians);
const cameraJumpPreemptiveCut = 0.2;
const largeCameraJumpPreemptiveCut = 0.35;
const waveCropBands = { halfWidthMetres: 250, crestDepthsMetres: [25, 90], faceDepthsMetres: [600, 1100] };

function easeInOut(fraction) {
    const clamped = Math.min(1, Math.max(0, fraction));
    return clamped * clamped * (3 - 2 * clamped);
}

export class MillersPlanetApp {
    static async boot(canvas, parameters) {
        const created = await createEngine(canvas);
        const app = new MillersPlanetApp(canvas, parameters, created);
        await app.warmUp();
        const hudRow = createHudRow(document.body);
        app.clockPanel = new ClockPanel(hudRow);
        app.waveCountdownPanel = new WaveCountdownPanel(hudRow);
        const startMuted = readStoredMutedPreference() ?? deviceHasTouch();
        app.audioSystem.muted = startMuted;
        app.muteButton = new MuteButton(hudRow, { muted: startMuted, onChange: (muted) => app.audioSystem.setMuted(muted) });
        app.input.onMuteKey = () => app.muteButton.toggle();
        app.applyHudVisibility();
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
        this.clockGauge = new ClockGauge();
        this.profiler.addTimedFrameListener((frameIndex, spanMilliseconds, busyMilliseconds, exclusiveMillisecondsByLabel) => {
            const slot = frameIndex % frameLogCapacity;
            if (this.frameLog.frameIndexBySlot[slot] !== frameIndex) {
                return;
            }
            const slowdown = this.clockGauge.observe(this.clockGauge.gaugeMilliseconds(this.profiler.labelNames, exclusiveMillisecondsByLabel));
            this.frameLog.recordClockSlowdown(frameIndex, slowdown);
            this.resolution.onFrameTimed(frameIndex, spanMilliseconds, this.frameLog.renderScaleBySlot[slot], slowdown);
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
        this.seaSimulation = new SeaSimulation({ engine, scene: this.scene, profiler: this.profiler });
        this.rippleField = new RippleField({ engine, scene: this.scene, profiler: this.profiler, seaSettings: this.seaSimulation.settings });
        this.sceneProxies = new SceneProxies(engine);
        this.seaSurface = new SeaSurface({ scene: this.scene, frameUniforms: this.frameUniforms, atmosphere: this.atmosphere, simulation: this.seaSimulation, rippleField: this.rippleField, sceneProxies: this.sceneProxies });
        this.scene.onBeforeRenderObservable.add(() => {
            this.dispatchGargantuaWork();
            this.atmosphere.dispatchFrame();
            this.seaSimulation.dispatchFrame(this.clock.timeSeconds, this.clock.lastDeltaSeconds);
            if (this.seaSimulation.enabled) {
                this.rippleField.dispatchFrame(this.rippleCentre[0], this.rippleCentre[1], this.clock.lastDeltaSeconds > 0);
            }
        });
        this.rippleCentre = [0, 0];
        this.worldOriginX = 0;
        this.worldOriginZ = 0;
        this.worldOriginShiftCount = 0;
        const absoluteSeabedHeightAt = createSeabedHeightFunction({
            meanDepthMetres: this.seaSimulation.settings.meanDepthMetres,
            depthVariationMetres: this.seaSurface.settings.seabedDepthVariationMetres,
            featureScalePerMetre: this.seaSurface.settings.seabedFeatureScalePerMetre,
            waterLevelMetres: this.seaSurface.settings.waterLevelMetres,
        });
        this.seabedHeightAt = (x, z) => absoluteSeabedHeightAt(x + this.worldOriginX, z + this.worldOriginZ);
        this.suitController = new SuitController({ seabedHeightAt: this.seabedHeightAt, waterLevelAt: () => this.seaSurface.settings.waterLevelMetres });
        this.suitFigure = new SuitFigure({ seabedHeightAt: this.seabedHeightAt });
        this.suitRenderer = new SuitRenderer({ scene: this.scene, engine, frameUniforms: this.frameUniforms, atmosphere: this.atmosphere, sceneProxies: this.sceneProxies });
        this.cameraRig = new CameraRig();
        this.injectedInput = { keys: new Set(), mouseDeltaPerSecondX: 0, mouseDeltaPerSecondY: 0, remainingSeconds: 0, pressedKeys: [] };
        this.scriptedMoveOverride = null;
        this.depthOfFieldAllowed = true;
        this.playerInput = { moveRight: 0, moveForward: 0, shift: false, mouseX: 0, mouseY: 0 };
        this.mouseDeltaScratch = new Float64Array(2);
        this.pressedKeysScratch = [];
        this.footStampPool = Array.from({ length: 8 }, () => ({ x: 0, z: 0, radius: 0.09, elongation: 1, forwardX: 0, forwardZ: 1, heightChange: 0, foam: 0, ringWeight: 0.48 }));
        this.footStampPoolIndex = 0;
        this.wakeStamps = [0, 1].map(() => ({ x: 0, z: 0, radius: 0.06, elongation: 1, forwardX: 0, forwardZ: 1, heightChange: 0, foam: 0, ringWeight: 0.3 }));
        this.lastWakeCrossings = new Float64Array(4).fill(Number.NaN);
        this.lander = new Lander({ scene: this.scene, frameUniforms: this.frameUniforms, atmosphere: this.atmosphere, sceneProxies: this.sceneProxies, waterLevelMetres: this.seaSurface.settings.waterLevelMetres });
        this.suitController.obstacleBoxes = () => (this.systemsEnabled?.ship && this.lander.state !== 4 ? this.lander.worldBoxes : null);
        this.cameraRig.obstacleBoxes = this.suitController.obstacleBoxes;
        this.placeOpeningShip();
        this.placeAstronaut(0, 0, openingYawRadians);
        const [waveTravelX, waveTravelZ] = this.seaSimulation.settings.windTravelDirection;
        this.giantWave = new GiantWave({ scene: this.scene, frameUniforms: this.frameUniforms, atmosphere: this.atmosphere, toward: [-waveTravelX, -waveTravelZ] });
        this.recedingWave = new GiantWave({ scene: this.scene, frameUniforms: this.frameUniforms, atmosphere: this.atmosphere, toward: [-waveTravelX, -waveTravelZ], name: "recedingWave" });
        for (const material of [this.seaSurface.material, ...this.suitRenderer.materials, this.lander.material]) {
            material.setUniformBuffer("waveParameters", this.giantWave.parameters);
        }
        this.underwaterView = new UnderwaterView({ scene: this.scene, frameUniforms: this.frameUniforms, atmosphere: this.atmosphere, waveParameters: this.giantWave.parameters });
        this.underwaterMedium = [0, 0, 0, 0];
        this.forceUnderwaterForWarmUp = false;
        this.waveState = createWaveState();
        this.choreographyState = createWaveState();
        this.waveCameraPoseScratch = createWaveCameraPose();
        this.cameraBlendScratch = createCameraBlendScratch();
        this.waveCameraWeight = 0;
        this.audioSplashes = [];
        this.shipWavesApplied = 0;
        this.lastImpact = null;
        this.testScene = new TestScene({ scene: this.scene, engine, frameUniforms: this.frameUniforms, profiler: this.profiler });
        this.postChain = new PostChain({ engine, scene: this.scene, beautyTargets: this.beautyTargets, profiler: this.profiler });
        this.postChain.settings.exposure = temporarySkyLook.exposure;
        this.defaultMaximumBlurRadiusPixels = this.postChain.settings.maximumBlurRadiusPixels;
        this.spike = new SpikeChecks(this);

        this.keyLightDirection = new Float32Array(3);
        directionFromAzimuthElevation(gargantuaAzimuthRadians, gargantuaElevationRadians, this.keyLightDirection);
        this.keyLightAngularRadiusRadians = 8 * degreesToRadians;
        this.keyLightRadiance = [24, 21, 17];

        this.frameIndex = 0;
        this.liveLoopPausedCount = 0;
        this.liveLoopPausedByHarness = false;
        this.previousCameraForward = new Float64Array(3);
        this.previousCameraForwardValid = false;
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
            sea: true,
            wave: false,
            astronaut: true,
            ship: true,
        };
        for (const name of parameters.disabledSystems) {
            this.setSystemEnabled(name, false);
        }
        if (parameters.shotName && shotDefinitions[parameters.shotName]) {
            this.applyShot(parameters.shotName, false);
        } else {
            this.enterPlayerMode();
        }
        engine.onResizeObservable.add(() => {
            this.invalidateTemporalHistory();
            this.clockGauge.reset();
        });
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
        return [this.skyDome.material, this.seaSurface.material, ...this.giantWave.materials, ...this.recedingWave.materials, this.underwaterView.material, ...this.suitRenderer.materials, this.lander.material];
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

    async setLook({ exposure, keyLightLuminance, keyLightColour, gargantuaRadianceScale, gargantuaShadowStrength, gargantua, atmosphere, clouds, post, sea, seaSurface } = {}) {
        if (sea) {
            this.seaSimulation.updateSettings(sea);
            await this.calibrateSeaHeight();
        }
        if (seaSurface) {
            this.seaSurface.updateSettings(seaSurface);
        }
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
            sea: { ...this.seaSimulation.settings, spectrumGain: this.seaSimulation.spectrumGain },
            seaSurface: { ...this.seaSurface.settings },
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

    async renderOneFrameAndWait() {
        if (this.warmUpComplete) {
            await this.renderFramesNow(1);
        } else {
            this.renderFrame(performance.now(), 1 / 60);
        }
        await this.device.queue.onSubmittedWorkDone();
    }

    async withSeaSimulationRunning(measurement) {
        const simulation = this.seaSimulation;
        const wasEnabled = simulation.enabled;
        simulation.enabled = true;
        try {
            return await measurement();
        } finally {
            simulation.enabled = wasEnabled;
        }
    }

    calibrateSeaHeight() {
        return this.withSeaSimulationRunning(async () => {
            const simulation = this.seaSimulation;
            simulation.spectrumGain = 1;
            simulation.requestInitialSpectrum();
            await this.renderOneFrameAndWait();
            const measuredBefore = await simulation.measureSignificantHeight();
            if (measuredBefore > 0) {
                simulation.spectrumGain = (simulation.settings.targetSignificantHeightMetres / measuredBefore) ** 2;
                simulation.requestInitialSpectrum();
                await this.renderOneFrameAndWait();
            }
            simulation.significantHeightMetres = await simulation.measureSignificantHeight();
            return { measuredBefore, measuredAfter: simulation.significantHeightMetres, spectrumGain: simulation.spectrumGain };
        });
    }

    measureSeaModeFrequency(options = {}) {
        return this.withSeaSimulationRunning(() => this.measureSeaModeFrequencyWhileRunning(options));
    }

    measureRippleRingSpeed(options = {}) {
        return this.withSeaSimulationRunning(() => this.measureRippleRingSpeedWhileRunning(options));
    }

    async measureSeaModeFrequencyWhileRunning({ cascade = 0, modeIndex = 4, amplitude = 0.01, firstTimeSeconds = 1.0, secondTimeSeconds = 1.05 } = {}) {
        const simulation = this.seaSimulation;
        const previousFreeze = this.clock.frozenAtSeconds;
        simulation.testMode = { cascade, modeIndex, amplitude };
        simulation.requestInitialSpectrum();
        const quarterWavelengthTexels = 256 / (4 * modeIndex);
        const phaseAt = async (seconds) => {
            this.clock.freeze(seconds);
            simulation.requestProbe([[0, 0, cascade], [quarterWavelengthTexels, 0, cascade]], false);
            await this.renderFramesNow(1);
            const results = await simulation.readProbeResults(2);
            return { seconds, heightAtOrigin: results[0][1], heightAtQuarterWavelength: results[1][1], phase: Math.atan2(results[1][1], results[0][1]) };
        };
        const first = await phaseAt(firstTimeSeconds);
        const second = await phaseAt(secondTimeSeconds);
        simulation.testMode = null;
        simulation.requestInitialSpectrum();
        this.clock.freeze(previousFreeze);
        await this.renderFramesNow(1);
        let phaseChange = second.phase - first.phase;
        while (phaseChange > Math.PI) {
            phaseChange -= 2 * Math.PI;
        }
        while (phaseChange < -Math.PI) {
            phaseChange += 2 * Math.PI;
        }
        const patchSize = simulation.settings.cascadeSizes[cascade];
        const wavenumber = (2 * Math.PI * modeIndex) / patchSize;
        const settings = simulation.settings;
        return {
            cascade,
            modeIndex,
            wavelengthMetres: patchSize / modeIndex,
            wavenumber,
            measuredAngularFrequency: phaseChange / (secondTimeSeconds - firstTimeSeconds),
            expectedFiniteDepth: simulation.angularFrequencyOf(wavenumber),
            expectedDeepWater: Math.sqrt(settings.gravity * wavenumber + settings.surfaceTensionOverDensity * wavenumber ** 3),
            twoMetreFiniteDepth: simulation.angularFrequencyOf(Math.PI),
            twoMetreDeepWater: Math.sqrt(settings.gravity * Math.PI + settings.surfaceTensionOverDensity * Math.PI ** 3),
            amplitudeSeen: Math.hypot(first.heightAtOrigin, first.heightAtQuarterWavelength),
            first,
            second,
        };
    }

    async measureRippleRingSpeedWhileRunning({ radiusMetres = 0.1, heightChangeMetres = 0.004, firstStep = 40, secondStep = 100 } = {}) {
        const ripples = this.rippleField;
        const previousFreeze = this.clock.frozenAtSeconds;
        this.clock.freeze(10);
        ripples.requestReset();
        await this.renderFramesNow(2);
        const centre = [...ripples.windowCentre];
        ripples.queueStamp({ x: centre[0], z: centre[1], radius: radiusMetres, heightChange: heightChangeMetres, foam: 0, ringWeight: 0.48 });
        ripples.requestPreroll(secondStep + 1);
        const texel = ripples.settings.texelMetres;
        const profiles = [];
        let stepsDone = 0;
        for (const targetStep of [firstStep, secondStep]) {
            await this.renderFramesNow(targetStep - stepsDone);
            stepsDone = targetStep;
            const pixels = await ripples.readTexture.readPixels(0, 0, null, true);
            const binCount = 240;
            const sums = new Float64Array(binCount);
            const counts = new Float64Array(binCount);
            const centreTexel = [Math.round(centre[0] / texel), Math.round(centre[1] / texel)];
            for (let row = 0; row < 512; row++) {
                for (let column = 0; column < 512; column++) {
                    const worldTexelX = ripples.windowLow[0] + (((column - ripples.windowLow[0]) % 512) + 512) % 512;
                    const worldTexelZ = ripples.windowLow[1] + (((row - ripples.windowLow[1]) % 512) + 512) % 512;
                    const radius = Math.hypot(worldTexelX - centreTexel[0], worldTexelZ - centreTexel[1]);
                    const bin = Math.floor(radius);
                    if (bin < binCount) {
                        const height = pixels[(row * 512 + column) * 4];
                        sums[bin] += height * height;
                        counts[bin] += 1;
                    }
                }
            }
            const amplitude = Array.from(sums, (sum, bin) => Math.sqrt(sum / Math.max(counts[bin], 1)));
            const peak = Math.max(...amplitude.slice(3));
            const peakBin = amplitude.indexOf(peak, 3);
            let innerEdgeBin = peakBin;
            while (innerEdgeBin > 0 && amplitude[innerEdgeBin] > peak * 0.2) {
                innerEdgeBin--;
            }
            let outerEdgeBin = peakBin;
            while (outerEdgeBin < binCount - 1 && amplitude[outerEdgeBin] > peak * 0.2) {
                outerEdgeBin++;
            }
            let weightedRadius = 0;
            let weight = 0;
            amplitude.forEach((value, bin) => {
                weightedRadius += (bin + 0.5) * value * value;
                weight += value * value;
            });
            profiles.push({
                step: targetStep,
                seconds: targetStep * ripples.settings.stepSeconds,
                peakRadiusMetres: (peakBin + 0.5) * texel,
                innerEdgeMetres: (innerEdgeBin + 0.5) * texel,
                outerEdgeMetres: (outerEdgeBin + 0.5) * texel,
                energyRadiusMetres: (weightedRadius / Math.max(weight, 1e-12)) * texel,
                peakAmplitudeMetres: peak,
            });
        }
        this.clock.freeze(previousFreeze);
        const [first, second] = profiles;
        const elapsed = second.seconds - first.seconds;
        return {
            profiles,
            peakSpeed: (second.peakRadiusMetres - first.peakRadiusMetres) / elapsed,
            innerEdgeSpeed: (second.innerEdgeMetres - first.innerEdgeMetres) / elapsed,
            outerEdgeSpeed: (second.outerEdgeMetres - first.outerEdgeMetres) / elapsed,
            energyRadiusSpeed: (second.energyRadiusMetres - first.energyRadiusMetres) / elapsed,
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
        } else if (name === "sea") {
            this.seaSimulation.enabled = isOn;
            this.seaSurface.mesh.setEnabled(isOn);
        } else if (name === "wave") {
            this.giantWave.setEnabled(isOn);
            this.giantWave.discardHistory();
            this.recedingWave.setEnabled(false);
            this.recedingWave.discardHistory();
            this.applyHudVisibility();
        } else if (name === "astronaut") {
            this.suitRenderer.setVisible(isOn);
        } else if (name === "ship") {
            this.lander.setVisible(isOn);
        }
    }

    applyShot(name, freezeTime = true) {
        const definition = shotDefinitions[name];
        if (!definition) {
            throw new Error(`Unknown shot ${name}`);
        }
        this.resetWorldOrigin();
        if (definition.pose) {
            const pose = definition.pose();
            this.cameraPose.position[0] = pose.position[0];
            this.cameraPose.position[1] = pose.position[1];
            this.cameraPose.position[2] = pose.position[2];
            this.cameraPose.yawRadians = pose.yawRadians;
            this.cameraPose.pitchRadians = pose.pitchRadians;
            this.cameraPose.verticalFieldOfViewRadians = definition.verticalFieldOfViewDegrees * degreesToRadians;
        }
        this.cameraTransition = null;
        this.cameraMode = "shot";
        this.currentShotName = name;
        this.depthOfFieldAllowed = definition.depthOfField !== false;
        this.postChain.settings.maximumBlurRadiusPixels = this.depthOfFieldAllowed ? this.defaultMaximumBlurRadiusPixels : 0;
        if (definition.rippleStamps) {
            this.rippleField.requestReset();
            for (const stamp of definition.rippleStamps) {
                if (stamp.afterSteps) {
                    this.rippleField.queueStampAfterSteps(stamp, stamp.afterSteps);
                } else {
                    this.rippleField.queueStamp(stamp);
                }
            }
            this.rippleField.requestPreroll(definition.ripplePrerollSteps ?? 30);
        }
        const hiddenSystems = definition.hiddenSystems ?? [];
        for (const sceneSystemName of ["testGeometry", "sea"]) {
            this.setSystemEnabled(sceneSystemName, !hiddenSystems.includes(sceneSystemName));
        }
        this.setSystemEnabled("astronaut", Boolean(definition.player));
        this.setSystemEnabled("ship", Boolean(definition.ship));
        if (definition.ship === "opening") {
            this.placeOpeningShip();
        } else if (definition.ship) {
            this.lander.place(definition.ship.x, definition.ship.z, definition.ship.yawRadians, definition.ship.state);
        }
        let crop = {};
        if (definition.player) {
            crop = this.preparePlayerShot(definition);
        }
        for (const systemName of hiddenSystems) {
            this.setSystemEnabled(systemName, false);
        }
        const shownSystems = definition.shownSystems ?? [];
        this.setSystemEnabled("wave", shownSystems.includes("wave"));
        if (freezeTime) {
            this.clock.freeze(definition.timeSeconds);
        }
        this.invalidateTemporalHistory();
        this.applyHudVisibility();
        return { name, crop };
    }

    applyHudVisibility() {
        const shot = this.currentShotName ? shotDefinitions[this.currentShotName] : null;
        const visible = this.parameters.hudVisible && (!shot || Boolean(shot.showHud));
        this.clockPanel?.setVisible(visible);
        this.waveCountdownPanel?.setVisible(visible && this.systemsEnabled.wave);
        this.input?.touchControls?.setHudVisible(visible);
        this.muteButton?.setVisible(visible);
    }

    enterPlayerMode() {
        this.cameraMode = "player";
        this.currentShotName = null;
        this.cameraTransition = null;
        this.setSystemEnabled("testGeometry", false);
        this.setSystemEnabled("sea", true);
        this.setSystemEnabled("wave", true);
        this.setSystemEnabled("astronaut", true);
        this.setSystemEnabled("ship", true);
        this.depthOfFieldAllowed = true;
        this.postChain.settings.maximumBlurRadiusPixels = this.defaultMaximumBlurRadiusPixels;
        if (this.warmUpComplete) {
            this.clock.freeze(null);
        }
        this.applyRigToCameraPose();
        this.applyHudVisibility();
        this.invalidateTemporalHistory();
    }

    placeOpeningShip() {
        const bearing = openingYawRadians + (30 * Math.PI) / 180;
        const distance = 20;
        this.lander.place(Math.sin(bearing) * distance, Math.cos(bearing) * distance, bearing + (125 * Math.PI) / 180, SHIP_STATE_INTACT);
    }

    setShipState(state) {
        this.lander.place(this.lander.positionX, this.lander.positionZ, this.lander.yawRadians, state);
        return this.shipStats();
    }

    relocateShipForWave(waveIndex, impactX = this.suitController.positionX, impactZ = this.suitController.positionZ) {
        const [travelX, travelZ] = this.seaSimulation.settings.windTravelDirection;
        const relocation = relocationForWave(waveIndex, impactX, impactZ, travelX, travelZ);
        this.lander.place(relocation.x, relocation.z, relocation.yawRadians, relocation.state);
        return { ...relocation, impact: [impactX, impactZ] };
    }

    walkToShip({ waveIndex = 1, impactX = 0, impactZ = 0, stepSeconds = 1 / 60, reachMetres = 2.0, limitSeconds = 400 } = {}) {
        const relocation = this.relocateShipForWave(waveIndex, impactX, impactZ);
        const controller = this.suitController;
        const figure = this.suitFigure;
        const towardShip = Math.atan2(relocation.x - impactX, relocation.z - impactZ);
        controller.teleport(impactX, impactZ, towardShip);
        figure.teleport(controller);
        const point = new Float64Array(3);
        const distanceAtStart = controller.distanceTravelled;
        let seconds = 0;
        let nearestBoxDistance = Infinity;
        while (seconds < limitSeconds) {
            const inputYaw = Math.atan2(this.lander.positionX - controller.positionX, this.lander.positionZ - controller.positionZ);
            controller.update(stepSeconds, 0, 1, false, inputYaw);
            figure.update(stepSeconds, controller);
            seconds += stepSeconds;
            nearestBoxDistance = Infinity;
            for (const box of this.lander.worldBoxes) {
                const contact = closestPointOnBox(box, controller.positionX, controller.positionY + 1.0, controller.positionZ, point);
                const distance = contact.inside ? 0 : Math.hypot(controller.positionX - point[0], controller.positionY + 1.0 - point[1], controller.positionZ - point[2]);
                nearestBoxDistance = Math.min(nearestBoxDistance, distance);
            }
            if (nearestBoxDistance <= reachMetres) {
                break;
            }
        }
        const result = {
            waveIndex,
            relocationDistanceMetres: relocation.distanceMetres,
            shipState: relocation.state,
            secondsToReach: seconds,
            reached: nearestBoxDistance <= reachMetres,
            finalDistanceToHullMetres: nearestBoxDistance,
            walkedMetres: controller.distanceTravelled - distanceAtStart,
            averageSpeedMetresPerSecond: (controller.distanceTravelled - distanceAtStart) / seconds,
        };
        this.placeOpeningShip();
        this.placeAstronaut(0, 0, openingYawRadians);
        return result;
    }

    probeShipCollision({ states = [0, 1, 2, 3], approachCount = 8, startDistanceMetres = 16, seconds = 20, stepSeconds = 1 / 60 } = {}) {
        const controller = this.suitController;
        const figure = this.suitFigure;
        const rig = this.cameraRig;
        const waterLevel = this.seaSurface.settings.waterLevelMetres;
        const point = new Float64Array(3);
        const signedDistanceToBox = (box, x, y, z) => {
            const contact = closestPointOnBox(box, x, y, z, point);
            return contact.inside ? -contact.leastPenetration : Math.hypot(x - point[0], y - point[1], z - point[2]);
        };
        const results = [];
        for (const state of states) {
            this.lander.place(0, 0, 0.4, state);
            const boxes = this.lander.worldBoxes;
            const result = { state, stateName: shipStateNames[state], approaches: approachCount, deepestPenetrationMetres: 0, deepestPenetrationBox: null, framesOverTwoCentimetres: 0, closestCameraMetres: Infinity, closestCameraBox: null, framesInContact: 0, largestCameraStepMetres: 0, cameraJumpsOverHalfMetre: 0, simulatedSeconds: 0 };
            for (let approach = 0; approach < approachCount; approach++) {
                const bearing = (approach / approachCount) * 2 * Math.PI;
                const towardShip = bearing + Math.PI;
                this.placeAstronaut(Math.sin(bearing) * startDistanceMetres, Math.cos(bearing) * startDistanceMetres, towardShip);
                let previousCameraX = rig.position[0];
                let previousCameraY = rig.position[1];
                let previousCameraZ = rig.position[2];
                for (let step = 0; step * stepSeconds < seconds; step++) {
                    const elapsed = step * stepSeconds;
                    controller.update(stepSeconds, 0, 1, false, towardShip);
                    figure.update(stepSeconds, controller);
                    rig.update(stepSeconds, controller, figure, 10 * Math.sin(elapsed * 0.6), 4 * Math.sin(elapsed * 0.45), waterLevel, false);
                    if (Math.hypot(rig.position[0] - previousCameraX, rig.position[1] - previousCameraY, rig.position[2] - previousCameraZ) > 0.5) {
                        result.cameraJumpsOverHalfMetre++;
                    }
                    previousCameraX = rig.position[0];
                    previousCameraY = rig.position[1];
                    previousCameraZ = rig.position[2];
                    result.simulatedSeconds += stepSeconds;
                    let deepestThisFrame = -Infinity;
                    for (const box of boxes) {
                        for (const height of bodySphereHeightsMetres) {
                            const penetration = bodySphereRadiusMetres - signedDistanceToBox(box, controller.positionX, controller.positionY + height, controller.positionZ);
                            if (penetration > deepestThisFrame) {
                                deepestThisFrame = penetration;
                            }
                            if (penetration > result.deepestPenetrationMetres) {
                                result.deepestPenetrationMetres = penetration;
                                result.deepestPenetrationBox = box.name;
                            }
                        }
                        const cameraDistance = signedDistanceToBox(box, rig.position[0], rig.position[1], rig.position[2]);
                        if (cameraDistance < result.closestCameraMetres) {
                            result.closestCameraMetres = cameraDistance;
                            result.closestCameraBox = box.name;
                        }
                    }
                    if (deepestThisFrame > -0.01) {
                        result.framesInContact++;
                    }
                    if (deepestThisFrame > 0.02) {
                        result.framesOverTwoCentimetres++;
                    }
                }
                result.largestCameraStepMetres = Math.max(result.largestCameraStepMetres, rig.largestFrameMoveMetres);
            }
            results.push(result);
        }
        this.placeOpeningShip();
        this.placeAstronaut(0, 0, openingYawRadians);
        return results;
    }

    shipStats() {
        const lander = this.lander;
        return {
            state: lander.state,
            stateName: shipStateNames[lander.state],
            position: [lander.positionX, lander.positionZ],
            yawDegrees: (lander.yawRadians * 180) / Math.PI,
            visible: lander.visible && lander.state !== 4,
            distanceFromAstronautMetres: lander.distanceTo(this.suitController.positionX, this.suitController.positionZ),
            proxyBoxes: lander.worldBoxes.length,
            triangles: lander.triangleCounts[lander.state],
        };
    }

    placeAstronaut(x, z, yawRadians, cameraYawRadians = yawRadians, cameraPitchRadians = null) {
        this.suitFigure.braceAmount = 0;
        this.suitController.inputLocked = false;
        this.suitController.teleport(x, z, yawRadians);
        this.suitFigure.teleport(this.suitController);
        this.suitFigure.update(0, this.suitController);
        this.cameraRig.snapTo(this.suitController, this.suitFigure, cameraYawRadians, cameraPitchRadians);
        this.suitRenderer.discardPreviousSkin();
        this.suitRenderer.writeSkin(this.suitFigure.skin);
        this.lastWakeCrossings.fill(Number.NaN);
    }

    preparePlayerShot(definition) {
        const player = definition.player;
        this.cameraRig.snapToPreset(player.preset ?? 0);
        this.placeAstronaut(player.x ?? 0, player.z ?? 0, player.yawRadians, player.cameraYawRadians ?? player.yawRadians, player.cameraPitchRadians ?? null);
        const stepSeconds = 1 / 60;
        const walkSteps = Math.round((player.walkSeconds ?? 0) / stepSeconds);
        const queuedStamps = [];
        for (let stepIndex = 0; stepIndex < walkSteps; stepIndex++) {
            const forward = player.moveForward ?? 1;
            const right = player.moveRight ?? 0;
            this.suitController.update(stepSeconds, right, forward, Boolean(player.shift), this.cameraRig.yawRadians);
            this.suitFigure.update(stepSeconds, this.suitController);
            this.cameraRig.update(stepSeconds, this.suitController, this.suitFigure, 0, 0, this.seaSurface.settings.waterLevelMetres);
            this.collectWaterContacts((stamp) => queuedStamps.push({ stamp: { ...stamp }, afterSteps: stepIndex }));
        }
        this.rippleField.requestReset();
        for (const { stamp, afterSteps } of queuedStamps) {
            if (afterSteps > 0) {
                this.rippleField.queueStampAfterSteps(stamp, afterSteps);
            } else {
                this.rippleField.queueStamp(stamp);
            }
        }
        this.rippleField.requestPreroll(Math.max(walkSteps, 1) + (player.ripplePrerollExtraSteps ?? 0));
        this.cameraRig.yawRadians = player.cameraYawRadians ?? this.cameraRig.yawRadians;
        if (player.cameraPitchRadians !== undefined) {
            this.cameraRig.pitchRadians = player.cameraPitchRadians;
        }
        const choreography = player.waveChoreography ? waveStateAt(definition.timeSeconds, this.choreographyState) : null;
        if (choreography) {
            this.applyWaveChoreographyToAstronaut(choreography, 0, true);
            for (let settleStep = 0; settleStep < 45; settleStep++) {
                this.suitFigure.update(stepSeconds, this.suitController);
            }
        }
        this.suitRenderer.discardPreviousSkin();
        this.suitRenderer.writeSkin(this.suitFigure.skin);
        if (player.cameraPose) {
            const pose = player.cameraPose(this.suitFigure, this.suitController);
            this.cameraPose.position[0] = pose.position[0];
            this.cameraPose.position[1] = pose.position[1];
            this.cameraPose.position[2] = pose.position[2];
            this.cameraPose.yawRadians = pose.yawRadians;
            this.cameraPose.pitchRadians = pose.pitchRadians;
            this.cameraPose.verticalFieldOfViewRadians = (pose.verticalFieldOfViewDegrees ?? definition.verticalFieldOfViewDegrees) * degreesToRadians;
            this.postChain.settings.helmetRimAmount = 0;
            this.updateHelmetVisibility();
        } else {
            this.cameraRig.update(0, this.suitController, this.suitFigure, 0, 0, this.seaSurface.settings.waterLevelMetres);
            this.applyRigToCameraPose();
        }
        if (choreography) {
            this.updateWave(definition.timeSeconds);
            this.applyWaveCamera(choreography);
        }
        if (player.cropAroundHelmet) {
            return { visor: this.helmetCropRectangle(player.cropAroundHelmet) };
        }
        if (player.cropWaveCrestAndFace) {
            return this.waveCrestCropRectangles(definition.timeSeconds);
        }
        return {};
    }

    helmetViewStats() {
        const world = this.suitFigure.world;
        const helmetX = world[BONE_HELMET * 16 + 12];
        const helmetY = world[BONE_HELMET * 16 + 13];
        const helmetZ = world[BONE_HELMET * 16 + 14];
        const frame = this.cameraFrame;
        const matrix = frame.viewProjection.m;
        const clipX = helmetX * matrix[0] + helmetY * matrix[4] + helmetZ * matrix[8] + matrix[12];
        const clipY = helmetX * matrix[1] + helmetY * matrix[5] + helmetZ * matrix[9] + matrix[13];
        const clipW = helmetX * matrix[3] + helmetY * matrix[7] + helmetZ * matrix[11] + matrix[15];
        const distanceMetres = Math.hypot(helmetX - frame.position.x, helmetY - frame.position.y, helmetZ - frame.position.z);
        if (clipW <= 0) {
            return { distanceMetres, screen: null, inView: false };
        }
        const radiusOnScreenY = helmetProxyRadiusMetres / (clipW * Math.tan(frame.verticalFieldOfViewRadians / 2));
        const radiusOnScreenX = radiusOnScreenY / (this.engine.getRenderWidth() / this.engine.getRenderHeight());
        const screenX = clipX / clipW;
        const screenY = clipY / clipW;
        return { distanceMetres, screen: [screenX, screenY], inView: Math.abs(screenX) < 1 + radiusOnScreenX && Math.abs(screenY) < 1 + radiusOnScreenY };
    }

    prepareCropProjection() {
        const output = [this.engine.getRenderWidth(), this.engine.getRenderHeight()];
        const pose = this.cameraPose;
        this.cameraFrame.setPose(pose.position[0], pose.position[1], pose.position[2], pose.yawRadians, pose.pitchRadians);
        this.cameraFrame.setVerticalFieldOfView(pose.verticalFieldOfViewRadians);
        const jitterWasOn = this.cameraFrame.jitterEnabled;
        this.cameraFrame.jitterEnabled = false;
        this.cameraFrame.prepare(output[0], output[1], this.beautyTargets.internalWidth, this.beautyTargets.internalHeight);
        this.cameraFrame.jitterEnabled = jitterWasOn;
        return { matrix: this.cameraFrame.viewProjection.m, outputWidth: output[0], outputHeight: output[1], cssScale: window.devicePixelRatio || 1 };
    }

    cropBoxAroundPoints(projection, points) {
        const matrix = projection.matrix;
        let minimumX = Infinity;
        let maximumX = -Infinity;
        let minimumY = Infinity;
        let maximumY = -Infinity;
        for (const [x, y, z] of points) {
            const clipX = x * matrix[0] + y * matrix[4] + z * matrix[8] + matrix[12];
            const clipY = x * matrix[1] + y * matrix[5] + z * matrix[9] + matrix[13];
            const clipW = x * matrix[3] + y * matrix[7] + z * matrix[11] + matrix[15];
            const screenX = (clipX / clipW * 0.5 + 0.5) * projection.outputWidth;
            const screenY = (0.5 - clipY / clipW * 0.5) * projection.outputHeight;
            minimumX = Math.min(minimumX, screenX);
            maximumX = Math.max(maximumX, screenX);
            minimumY = Math.min(minimumY, screenY);
            maximumY = Math.max(maximumY, screenY);
        }
        const cssScale = projection.cssScale;
        const left = Math.max(0, Math.floor(minimumX / cssScale));
        const top = Math.max(0, Math.floor(minimumY / cssScale));
        const right = Math.min(projection.outputWidth / cssScale, Math.ceil(maximumX / cssScale));
        const bottom = Math.min(projection.outputHeight / cssScale, Math.ceil(maximumY / cssScale));
        return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
    }

    helmetCropRectangle(halfSizeMetres) {
        const projection = this.prepareCropProjection();
        const world = this.suitFigure.world;
        const centre = [world[BONE_HELMET * 16 + 12], world[BONE_HELMET * 16 + 13], world[BONE_HELMET * 16 + 14]];
        const corners = [];
        for (const offsetX of [-halfSizeMetres, halfSizeMetres]) {
            for (const offsetY of [-halfSizeMetres, halfSizeMetres]) {
                for (const offsetZ of [-halfSizeMetres, halfSizeMetres]) {
                    corners.push([centre[0] + offsetX, centre[1] + offsetY, centre[2] + offsetZ]);
                }
            }
        }
        return this.cropBoxAroundPoints(projection, corners);
    }

    waveCrestCropRectangles(timeSeconds) {
        this.updateWave(timeSeconds);
        const projection = this.prepareCropProjection();
        const wave = this.giantWave;
        const pose = this.cameraPose;
        const [towardX, towardZ] = wave.toward;
        const viewLateral = wave.lateral(pose.position[0], pose.position[2]);
        const frontWidth = wave.settings.frontWidthMetres;
        const crest = { aheadMetres: 0, heightMetres: 0, crestOffsetMetres: 0 };
        const bands = { crest: waveCropBands.crestDepthsMetres, face: waveCropBands.faceDepthsMetres };
        const pointsByBand = { crest: [], face: [] };
        for (const lateralOffset of [-waveCropBands.halfWidthMetres, 0, waveCropBands.halfWidthMetres]) {
            const lateral = viewLateral + lateralOffset;
            const baseX = towardZ * lateral;
            const baseZ = -towardX * lateral;
            wave.localCrestAt(baseX, baseZ, crest);
            for (const [bandName, depths] of Object.entries(bands)) {
                for (const depth of depths) {
                    const aheadOfFace = crest.aheadMetres - frontWidth * (1 - Math.sqrt(Math.max(0, 1 - depth / crest.heightMetres)));
                    pointsByBand[bandName].push([baseX + towardX * aheadOfFace, crest.heightMetres - depth, baseZ + towardZ * aheadOfFace]);
                }
            }
        }
        return { crest: this.cropBoxAroundPoints(projection, pointsByBand.crest), face: this.cropBoxAroundPoints(projection, pointsByBand.face) };
    }

    gatherPlayerInput(deltaSeconds) {
        const input = this.input;
        const injected = this.injectedInput;
        const held = (code) => input.isHeld(code) || injected.keys.has(code);
        let moveForward = 0;
        let moveRight = 0;
        if (held("KeyW") || held("ArrowUp")) {
            moveForward += 1;
        }
        if (held("KeyS") || held("ArrowDown")) {
            moveForward -= 1;
        }
        if (held("KeyD") || held("ArrowRight")) {
            moveRight += 1;
        }
        if (held("KeyA") || held("ArrowLeft")) {
            moveRight -= 1;
        }
        const touchMove = input.touchMove;
        const touchMoveActive = touchMove.pointerId !== null && moveForward === 0 && moveRight === 0;
        if (touchMoveActive) {
            moveForward = touchMove.moveForward;
            moveRight = touchMove.moveRight;
        }
        const player = this.playerInput;
        const scripted = this.scriptedMoveOverride;
        player.moveForward = scripted ? scripted.moveForward : moveForward;
        player.moveRight = scripted ? scripted.moveRight : moveRight;
        player.shift = scripted ? Boolean(scripted.shift) : held("ShiftLeft") || held("ShiftRight") || (touchMoveActive && touchMove.run);
        input.consumeMouseDelta(this.mouseDeltaScratch);
        player.mouseX = this.mouseDeltaScratch[0];
        player.mouseY = this.mouseDeltaScratch[1];
        if (injected.remainingSeconds > 0) {
            const used = Math.min(Math.max(deltaSeconds, 0), injected.remainingSeconds);
            player.mouseX += injected.mouseDeltaPerSecondX * used;
            player.mouseY += injected.mouseDeltaPerSecondY * used;
            injected.remainingSeconds -= used;
            if (injected.remainingSeconds <= 1e-9) {
                injected.remainingSeconds = 0;
                injected.keys.clear();
            }
        }
        input.takePressedKeys(this.pressedKeysScratch);
        for (const code of injected.pressedKeys) {
            this.pressedKeysScratch.push(code);
        }
        injected.pressedKeys.length = 0;
        for (const code of this.pressedKeysScratch) {
            if (code === "KeyC") {
                this.cameraRig.cyclePreset();
            }
        }
        return player;
    }

    async runFootDriftWalk({ script = scriptedWalk, durationSeconds = 27, stepSeconds = 1 / 60, startX = 3.1, startZ = -2.4, startYawDegrees = 0 } = {}) {
        this.enterPlayerMode();
        this.cameraRig.snapToPreset(0);
        const startYaw = (startYawDegrees * Math.PI) / 180;
        this.placeAstronaut(startX, startZ, startYaw, startYaw);
        this.suitFigure.maximumStanceReachExcessMetres = 0;
        const samples = [];
        this.liveLoopPausedCount++;
        try {
            let seconds = 0;
            let frameNumber = 0;
            while (seconds < durationSeconds) {
                const input = scriptedInputAt(script, seconds);
                this.scriptedMoveOverride = { moveRight: input.moveRight, moveForward: input.moveForward, shift: input.shift, inputYawRadians: startYaw };
                this.renderFrame(performance.now(), stepSeconds);
                seconds += stepSeconds;
                frameNumber++;
                const feet = this.stats().feet;
                samples.push({
                    seconds,
                    label: input.label,
                    feet: feet.map((foot) => ({ inStance: foot.inStance, stanceSerial: foot.stanceSerial, contactMask: foot.contactMask, solePoints: [foot.heel, foot.mid, foot.ball, foot.toe] })),
                });
                if (frameNumber % 4 === 0) {
                    await this.device.queue.onSubmittedWorkDone();
                }
            }
            await this.waitForGpuTimings();
        } finally {
            this.scriptedMoveOverride = null;
            this.liveLoopPausedCount--;
            this.pacer.reset();
            this.lastRenderedRafTimeMilliseconds = -1;
        }
        return {
            samples,
            maximumStanceReachExcessMetres: this.suitFigure.maximumStanceReachExcessMetres,
            stances: this.suitFigure.feet.map((foot) => foot.stanceSerial),
            gpuErrors: this.gpuErrors.messages ? [...this.gpuErrors.messages] : [],
        };
    }

    injectInput({ keys = [], mouseDelta = [0, 0], durationMs = 0, press = [] } = {}) {
        const injected = this.injectedInput;
        injected.keys.clear();
        for (const code of keys) {
            injected.keys.add(code);
        }
        const durationSeconds = Math.max(durationMs, 0) / 1000;
        injected.remainingSeconds = durationSeconds;
        injected.mouseDeltaPerSecondX = durationSeconds > 0 ? mouseDelta[0] / durationSeconds : 0;
        injected.mouseDeltaPerSecondY = durationSeconds > 0 ? mouseDelta[1] / durationSeconds : 0;
        if (durationSeconds === 0 && (mouseDelta[0] || mouseDelta[1])) {
            this.input.pendingMouseDeltaX += mouseDelta[0];
            this.input.pendingMouseDeltaY += mouseDelta[1];
        }
        for (const code of press) {
            injected.pressedKeys.push(code);
        }
        return { keys: [...injected.keys], durationMs, press };
    }

    applyWaveChoreographyToAstronaut(state, deltaSeconds, snapFacing = false) {
        const controller = this.suitController;
        const active = this.systemsEnabled.wave;
        controller.inputLocked = active && inputLockedFor(state);
        this.suitFigure.braceAmount = active ? braceAmountFor(state) : 0;
        if (active && state.phase === WAVE_PHASE_BRACE) {
            const waveYaw = Math.atan2(this.giantWave.toward[0], this.giantWave.toward[1]);
            const error = Math.atan2(Math.sin(waveYaw - controller.facingYaw), Math.cos(waveYaw - controller.facingYaw));
            const largestStep = snapFacing ? Math.PI : (100 * Math.PI / 180) * Math.max(deltaSeconds, 0);
            controller.facingYaw += Math.max(-largestStep, Math.min(largestStep, error));
            controller.requestedYaw = controller.facingYaw;
        }
    }

    applyWaveCamera(state) {
        const weight = this.systemsEnabled.wave ? waveCameraWeight(state) : 0;
        this.waveCameraWeight = weight;
        if (weight <= 0) {
            return;
        }
        const controller = this.suitController;
        const world = this.suitFigure.world;
        const helmet = [world[BONE_HELMET * 16 + 12], world[BONE_HELMET * 16 + 13], world[BONE_HELMET * 16 + 14]];
        const wave = this.giantWave;
        const crest = wave.localCrestAt(helmet[0], helmet[2], wave.scratchCrest);
        const crestElevation = Math.atan2(crest.heightMetres - helmet[1], Math.max(crest.aheadMetres, 1));
        const astronaut = { x: controller.positionX, z: controller.positionZ, groundY: controller.positionY, yawRadians: controller.facingYaw };
        const pose = waveCameraPose(state, astronaut, helmet, crestElevation, this.seaSurface.settings.waterLevelMetres, this.waveCameraPoseScratch);
        const target = blendCameraPoseAroundPivot(this.cameraPose, pose, helmet[0], helmet[2], weight, this.cameraBlendScratch);
        const helmetDistance = Math.hypot(helmet[0] - target.position[0], helmet[1] - target.position[1], helmet[2] - target.position[2]);
        this.postChain.settings.focusDistanceMetres += (helmetDistance - this.postChain.settings.focusDistanceMetres) * weight;
        this.postChain.settings.helmetRimAmount *= 1 - weight;
        this.updateHelmetVisibility();
    }

    updatePlayer(deltaSeconds) {
        const choreography = waveStateAt(this.clock.timeSeconds, this.choreographyState);
        this.applyWaveChoreographyToAstronaut(choreography, deltaSeconds);
        const player = this.gatherPlayerInput(deltaSeconds);
        const inputYaw = this.scriptedMoveOverride ? this.scriptedMoveOverride.inputYawRadians : this.cameraRig.yawRadians;
        this.suitController.update(deltaSeconds, player.moveRight, player.moveForward, player.shift, inputYaw);
        this.suitFigure.update(deltaSeconds, this.suitController);
        const forwardDominantInput = player.moveForward > 0.5 && Math.abs(player.moveRight) < 0.5;
        this.cameraRig.update(deltaSeconds, this.suitController, this.suitFigure, player.mouseX, player.mouseY, this.seaSurface.settings.waterLevelMetres, forwardDominantInput);
        this.shiftWorldOriginIfFar();
        this.applyRigToCameraPose();
        this.applyWaveCamera(choreography);
        this.collectWaterContacts((stamp) => this.rippleField.queueStamp(stamp));
    }

    applyRigToCameraPose() {
        const rig = this.cameraRig;
        this.cameraPose.position[0] = rig.position[0];
        this.cameraPose.position[1] = rig.position[1];
        this.cameraPose.position[2] = rig.position[2];
        this.cameraPose.yawRadians = rig.outputYawRadians;
        this.cameraPose.pitchRadians = rig.outputPitchRadians;
        this.cameraPose.verticalFieldOfViewRadians = rig.verticalFieldOfViewRadians;
        this.viewPreset = rig.presetIndex;
        const rimAmount = Math.min(1, Math.max(0, (rig.firstPersonAmount - 0.6) / 0.4));
        this.postChain.settings.helmetRimAmount = rimAmount * rimAmount * (3 - 2 * rimAmount);
        this.postChain.settings.focusDistanceMetres = rig.focusDistanceMetres;
        this.postChain.settings.maximumBlurRadiusPixels = this.depthOfFieldAllowed ? this.defaultMaximumBlurRadiusPixels * (1 - rig.firstPersonAmount) : 0;
        this.updateHelmetVisibility();
    }

    updateHelmetVisibility() {
        const world = this.suitFigure.world;
        const pose = this.cameraPose.position;
        const distanceToHelmet = Math.hypot(world[BONE_HELMET * 16 + 12] - pose[0], world[BONE_HELMET * 16 + 13] - pose[1], world[BONE_HELMET * 16 + 14] - pose[2]);
        this.suitRenderer.setFirstPerson(distanceToHelmet < 0.32);
    }

    writeAstronautProxies() {
        const data = this.sceneProxies.astronautCapsuleData;
        const bounds = this.sceneProxies.astronautBounds;
        if (!this.systemsEnabled.astronaut) {
            bounds[3] = 0;
            return;
        }
        const figure = this.suitFigure;
        const world = figure.world;
        let capsule = 0;
        const writeCapsule = (startX, startY, startZ, endX, endY, endZ, radius, materialCode) => {
            const offset = capsule * 8;
            data[offset] = startX;
            data[offset + 1] = startY;
            data[offset + 2] = startZ;
            data[offset + 3] = radius;
            data[offset + 4] = endX;
            data[offset + 5] = endY;
            data[offset + 6] = endZ;
            data[offset + 7] = materialCode;
            capsule++;
        };
        const bonePosition = (bone, axis) => world[bone * 16 + 12 + axis];
        for (let footIndex = 0; footIndex < 2; footIndex++) {
            const sole = figure.feet[footIndex].solePoints;
            writeCapsule(sole[0], sole[1] + 0.055, sole[2], sole[9], sole[10] + 0.04, sole[11], 0.06, 1);
        }
        for (let footIndex = 0; footIndex < 2; footIndex++) {
            const ankle = figure.feet[footIndex].ankle;
            const kneeX = figure.kneePositions[footIndex * 3];
            const kneeY = figure.kneePositions[footIndex * 3 + 1];
            const kneeZ = figure.kneePositions[footIndex * 3 + 2];
            const shinLength = Math.hypot(kneeX - ankle[0], kneeY - ankle[1], kneeZ - ankle[2]) || 1;
            const shaftFraction = 0.11 / shinLength;
            writeCapsule(ankle[0], ankle[1], ankle[2], ankle[0] + (kneeX - ankle[0]) * shaftFraction, ankle[1] + (kneeY - ankle[1]) * shaftFraction, ankle[2] + (kneeZ - ankle[2]) * shaftFraction, 0.09, 1);
        }
        for (let footIndex = 0; footIndex < 2; footIndex++) {
            const ankle = figure.feet[footIndex].ankle;
            const kneeX = figure.kneePositions[footIndex * 3];
            const kneeY = figure.kneePositions[footIndex * 3 + 1];
            const kneeZ = figure.kneePositions[footIndex * 3 + 2];
            const shinLength = Math.hypot(kneeX - ankle[0], kneeY - ankle[1], kneeZ - ankle[2]) || 1;
            const shaftFraction = 0.11 / shinLength;
            writeCapsule(ankle[0] + (kneeX - ankle[0]) * shaftFraction, ankle[1] + (kneeY - ankle[1]) * shaftFraction, ankle[2] + (kneeZ - ankle[2]) * shaftFraction, kneeX, kneeY, kneeZ, 0.086, 0);
        }
        for (let footIndex = 0; footIndex < 2; footIndex++) {
            writeCapsule(
                figure.hipPositions[footIndex * 3], figure.hipPositions[footIndex * 3 + 1], figure.hipPositions[footIndex * 3 + 2],
                figure.kneePositions[footIndex * 3], figure.kneePositions[footIndex * 3 + 1], figure.kneePositions[footIndex * 3 + 2], 0.105, 0,
            );
        }
        writeCapsule(bonePosition(BONE_PELVIS, 0), bonePosition(BONE_PELVIS, 1) - 0.08, bonePosition(BONE_PELVIS, 2), bonePosition(BONE_NECK, 0), bonePosition(BONE_NECK, 1) - 0.06, bonePosition(BONE_NECK, 2), 0.2, 0);
        writeCapsule(bonePosition(BONE_HELMET, 0), bonePosition(BONE_HELMET, 1), bonePosition(BONE_HELMET, 2), bonePosition(BONE_HELMET, 0), bonePosition(BONE_HELMET, 1), bonePosition(BONE_HELMET, 2), helmetProxyRadiusMetres, 0);
        for (const [upperBone, handBone] of [[BONE_UPPER_ARM_LEFT, BONE_HAND_LEFT], [BONE_UPPER_ARM_RIGHT, BONE_HAND_RIGHT]]) {
            writeCapsule(bonePosition(upperBone, 0), bonePosition(upperBone, 1), bonePosition(upperBone, 2), bonePosition(handBone, 0), bonePosition(handBone, 1), bonePosition(handBone, 2), 0.07, 0);
        }
        bounds[0] = this.suitController.positionX;
        bounds[1] = this.suitController.positionY + 0.95;
        bounds[2] = this.suitController.positionZ;
        bounds[3] = 0.55;
    }

    collectWaterContacts(emitStamp) {
        const figure = this.suitFigure;
        const waterLevel = this.seaSurface.settings.waterLevelMetres;
        for (let eventIndex = 0; eventIndex < figure.eventCount; eventIndex++) {
            const stamp = this.footStampPool[this.footStampPoolIndex];
            this.footStampPoolIndex = (this.footStampPoolIndex + 1) % this.footStampPool.length;
            const yaw = figure.eventYaws[eventIndex];
            const strength = figure.eventStrengths[eventIndex];
            const heelStrike = figure.eventKinds[eventIndex] === FOOT_EVENT_HEEL_STRIKE;
            stamp.x = figure.eventPositions[eventIndex * 3] + Math.sin(yaw) * (heelStrike ? 0.1 : -0.05);
            stamp.z = figure.eventPositions[eventIndex * 3 + 2] + Math.cos(yaw) * (heelStrike ? 0.1 : -0.05);
            stamp.radius = heelStrike ? 0.09 : 0.07;
            stamp.elongation = heelStrike ? 1.7 : 1.3;
            stamp.forwardX = Math.sin(yaw);
            stamp.forwardZ = Math.cos(yaw);
            stamp.heightChange = (heelStrike ? 0.02 : 0.01) * strength;
            stamp.foam = (heelStrike ? 0.32 : 0.14) * strength;
            stamp.ringWeight = 0.48;
            emitStamp(stamp);
            if (heelStrike && this.audioSplashes.length < 4) {
                this.audioSplashes.push(Math.min(1, 0.4 + 0.6 * strength));
            }
        }
        for (let footIndex = 0; footIndex < 2; footIndex++) {
            const foot = figure.feet[footIndex];
            const kneeY = figure.kneePositions[footIndex * 3 + 1];
            const ankleY = foot.ankle[1];
            const previousX = this.lastWakeCrossings[footIndex * 2];
            const previousZ = this.lastWakeCrossings[footIndex * 2 + 1];
            if (!(kneeY > waterLevel && ankleY < waterLevel)) {
                this.lastWakeCrossings[footIndex * 2] = Number.NaN;
                continue;
            }
            const fraction = (kneeY - waterLevel) / (kneeY - ankleY);
            const crossingX = figure.kneePositions[footIndex * 3] + (foot.ankle[0] - figure.kneePositions[footIndex * 3]) * fraction;
            const crossingZ = figure.kneePositions[footIndex * 3 + 2] + (foot.ankle[2] - figure.kneePositions[footIndex * 3 + 2]) * fraction;
            this.lastWakeCrossings[footIndex * 2] = crossingX;
            this.lastWakeCrossings[footIndex * 2 + 1] = crossingZ;
            if (Number.isNaN(previousX)) {
                continue;
            }
            const movedX = crossingX - previousX;
            const movedZ = crossingZ - previousZ;
            const moved = Math.hypot(movedX, movedZ);
            if (moved < 0.002) {
                continue;
            }
            const stamp = this.wakeStamps[footIndex];
            stamp.x = crossingX;
            stamp.z = crossingZ;
            stamp.radius = 0.06;
            stamp.elongation = 1 + Math.min(moved / 0.02, 1);
            stamp.forwardX = movedX / moved;
            stamp.forwardZ = movedZ / moved;
            stamp.heightChange = Math.min(moved * 0.6, 0.015);
            stamp.foam = Math.min(moved * 4, 0.1);
            stamp.ringWeight = 0.3;
            emitStamp(stamp);
        }
    }

    shiftWorldOriginIfFar() {
        const controller = this.suitController;
        if (Math.abs(controller.positionX) <= worldOriginShiftDistanceMetres && Math.abs(controller.positionZ) <= worldOriginShiftDistanceMetres) {
            return;
        }
        this.shiftWorldOrigin(
            Math.round(controller.positionX / worldOriginShiftStepMetres) * worldOriginShiftStepMetres,
            Math.round(controller.positionZ / worldOriginShiftStepMetres) * worldOriginShiftStepMetres,
        );
    }

    shiftWorldOrigin(deltaX, deltaZ) {
        if (deltaX === 0 && deltaZ === 0) {
            return;
        }
        this.worldOriginX += deltaX;
        this.worldOriginZ += deltaZ;
        this.worldOriginShiftCount++;
        this.suitController.shiftOrigin(deltaX, deltaZ);
        this.suitFigure.shiftOrigin(deltaX, deltaZ);
        this.suitRenderer.shiftOrigin(deltaX, deltaZ);
        this.cameraRig.shiftOrigin(deltaX, deltaZ);
        this.cameraFrame.shiftOrigin(deltaX, deltaZ);
        this.cameraPose.position[0] -= deltaX;
        this.cameraPose.position[2] -= deltaZ;
        if (this.cameraTransition) {
            for (const position of [this.cameraTransition.fromPosition, this.cameraTransition.toPosition]) {
                position[0] -= deltaX;
                position[2] -= deltaZ;
            }
        }
        for (let footIndex = 0; footIndex < 2; footIndex++) {
            this.lastWakeCrossings[footIndex * 2] -= deltaX;
            this.lastWakeCrossings[footIndex * 2 + 1] -= deltaZ;
        }
        this.rippleCentre[0] -= deltaX;
        this.rippleCentre[1] -= deltaZ;
        this.rippleField.shiftOrigin(deltaX, deltaZ);
        this.lander.shiftOrigin(deltaX, deltaZ);
        this.giantWave.shiftOrigin(deltaX, deltaZ);
        this.recedingWave.shiftOrigin(deltaX, deltaZ);
        if (this.lastImpact) {
            this.lastImpact.x -= deltaX;
            this.lastImpact.z -= deltaZ;
        }
        this.atmosphere.shiftOrigin(deltaX, deltaZ);
        this.seaSurface.setWorldOrigin(this.worldOriginX, this.worldOriginZ);
    }

    resetWorldOrigin() {
        this.atmosphere.shiftOrigin(-this.worldOriginX, -this.worldOriginZ);
        this.giantWave.resetOrigin();
        this.recedingWave.resetOrigin();
        this.worldOriginX = 0;
        this.worldOriginZ = 0;
        this.seaSurface.setWorldOrigin(0, 0);
    }

    updateWave(seconds = this.clock.timeSeconds) {
        const state = waveStateAt(seconds, this.waveState);
        this.wavePhaseCode = state.phase;
        const wave = this.giantWave;
        const camera = this.cameraFrame.position;
        const followAstronaut = this.systemsEnabled.astronaut;
        const referenceX = followAstronaut ? this.suitController.positionX : camera.x;
        const referenceZ = followAstronaut ? this.suitController.positionZ : camera.z;
        wave.setHeightFraction(state.heightFraction);
        wave.place(wave.along(referenceX, referenceZ) + state.frontDistanceMetres + wave.settings.frontWidthMetres + wave.crestOffsetAt(referenceX, referenceZ), wave.lateral(camera.x, camera.z), wave.along(camera.x, camera.z));
        const secondsMoving = waveSchedule.periodSeconds - state.secondsBeforeImpact;
        wave.motionAmount = Math.min(1, Math.max(0, secondsMoving / 2));
        wave.flowSeconds = Math.max(0, secondsMoving);
        this.updateRecedingWave(state, seconds, referenceX, referenceZ, camera);
        wave.reflectRecedingWave(this.recedingWave);
        wave.writeParameters();
        wave.updateLighting(camera.x, camera.y, camera.z, Math.asin(Math.min(1, Math.max(-1, this.keyLightDirection[1]))), this.keyLightAngularRadiusRadians);
        this.updateUnderwater(camera);
        this.updateAftermath(state, seconds);
        this.updateAudio(state);
        if (state.secondsBeforeImpact <= 0 && (!this.lastImpact || this.lastImpact.waveIndex !== state.index)) {
            this.lastImpact = { waveIndex: state.index, x: referenceX, z: referenceZ, timeSeconds: state.impactSeconds };
        }
        if (this.cameraMode === "player" && this.systemsEnabled.wave) {
            const completedWaves = state.secondsBeforeImpact <= -1 ? state.index : state.index - 1;
            if (completedWaves !== this.shipWavesApplied) {
                if (completedWaves === 0) {
                    this.placeOpeningShip();
                } else {
                    const impactX = this.lastImpact && this.lastImpact.waveIndex === completedWaves ? this.lastImpact.x : referenceX;
                    const impactZ = this.lastImpact && this.lastImpact.waveIndex === completedWaves ? this.lastImpact.z : referenceZ;
                    this.relocateShipForWave(completedWaves, impactX, impactZ);
                }
                this.shipWavesApplied = completedWaves;
            }
        }
    }

    updateRecedingWave(state, seconds, referenceX, referenceZ, camera) {
        const receding = this.recedingWave;
        const visible = this.systemsEnabled.wave && this.giantWave.enabled && state.previousIndex >= 1 && state.previousHeightFraction > 0;
        if (receding.enabled !== visible) {
            receding.setEnabled(visible);
            receding.discardHistory();
        }
        if (!visible) {
            return;
        }
        const anchoredAtImpact = this.lastImpact && this.lastImpact.waveIndex === state.previousIndex;
        const anchorX = anchoredAtImpact ? this.lastImpact.x : referenceX;
        const anchorZ = anchoredAtImpact ? this.lastImpact.z : referenceZ;
        receding.setHeightFraction(state.previousHeightFraction);
        receding.place(receding.along(anchorX, anchorZ) + state.previousFrontDistanceMetres + receding.settings.frontWidthMetres + receding.crestOffsetAt(anchorX, anchorZ), receding.lateral(camera.x, camera.z), receding.along(camera.x, camera.z));
        const secondsSinceImpact = seconds - impactSecondsOf(state.previousIndex);
        receding.motionAmount = 1;
        receding.flowSeconds = waveSchedule.periodSeconds + Math.max(0, secondsSinceImpact);
        receding.writeParameters();
    }

    updateAudio(state) {
        const schedule = waveSchedule;
        let approach = 0;
        if (this.systemsEnabled.wave) {
            if (state.secondsBeforeImpact > 0) {
                approach = Math.min(1, Math.max(0, (schedule.approachSeconds - state.secondsBeforeImpact) / schedule.approachSeconds));
            } else if (state.secondsBeforeImpact > -schedule.underwaterSeconds) {
                approach = 1;
            } else {
                approach = Math.max(0, 1 - (-state.secondsBeforeImpact - schedule.underwaterSeconds) / schedule.drainSeconds);
            }
        }
        this.audioSystem.update({ approach, underwater: this.underwaterView.active, splashes: this.audioSplashes });
        this.audioSplashes.length = 0;
    }

    updateAftermath(state, seconds) {
        const sinceImpact = state.secondsBeforeImpact <= 0 ? -state.secondsBeforeImpact : state.index > 1 ? seconds - impactSecondsOf(state.index - 1) : Infinity;
        const active = this.systemsEnabled.wave;
        const drainStart = waveSchedule.underwaterSeconds;
        const settle = drainStart + waveSchedule.drainSeconds;
        const smooth = (low, high, value) => {
            const x = Math.min(1, Math.max(0, (value - low) / (high - low)));
            return x * x * (3 - 2 * x);
        };
        let level = 0;
        let foam = 0;
        let flow = 0;
        let wetness = 0;
        if (active && sinceImpact >= 0) {
            level = sinceImpact < drainStart ? 0.6 : 0.6 * (1 - smooth(0, 4.5, sinceImpact - drainStart));
            foam = sinceImpact < drainStart ? 1 : 1 - smooth(0, 30, sinceImpact - drainStart);
            flow = 6 * Math.max(0, sinceImpact - drainStart);
            wetness = sinceImpact < settle ? 1 : 1 - smooth(0, 90, sinceImpact - settle);
        }
        this.seaSurface.drainLevelMetres = level;
        this.seaSurface.aftermathFoam = foam;
        this.seaSurface.aftermathFlowMetres = flow;
        if (Math.abs(wetness - this.suitRenderer.look.wetAll) > 0.004 || (wetness === 0 && this.suitRenderer.look.wetAll !== 0)) {
            this.suitRenderer.updateLook({ wetAll: wetness });
        }
    }

    updateUnderwater(camera) {
        const wave = this.giantWave;
        const underwater = this.forceUnderwaterForWarmUp || (this.systemsEnabled.wave && wave.enabled && camera.y < wave.waterHeightAt(camera.x, camera.z) - 0.05);
        if (this.underwaterView.active && !underwater && !this.forceUnderwaterForWarmUp) {
            this.resolution.requestPreemptiveCut(0.2, "underwater exit");
        }
        this.underwaterView.setActive(underwater);
        this.skyDome.mesh.setEnabled(!underwater);
        this.seaSurface.mesh.setEnabled(this.systemsEnabled.sea && !underwater);
        wave.mesh.setEnabled(wave.enabled && !underwater);
        const medium = this.underwaterMedium;
        if (!underwater) {
            medium[3] = 0;
            return;
        }
        const settings = this.underwaterView.settings;
        const illuminance = this.keyLightMeasurement ? this.keyLightMeasurement.illuminance : [0.22, 0.2, 0.2];
        const radiance = this.underwaterView.mediumRadiance([illuminance[0] * 2.4, illuminance[1] * 2.4, illuminance[2] * 2.4]);
        medium[0] = radiance[0];
        medium[1] = radiance[1];
        medium[2] = radiance[2];
        medium[3] = settings.densityPerMetre;
        wave.lighting.keyVisibility = settings.keyLightKept;
        wave.lighting.skyVisibility = settings.skyLightKept;
        wave.lighting.hazeFactor = 1;
    }

    skipTo({ waveIndex = 1, phase = "a", secondsIntoPhase = 0 } = {}) {
        const seconds = secondsForPhase(waveIndex, phase, secondsIntoPhase);
        this.clock.jumpTo(seconds);
        this.giantWave.discardHistory();
        this.recedingWave.discardHistory();
        this.invalidateTemporalHistory();
        return { timeSeconds: seconds, ...this.waveStats() };
    }

    waveStats() {
        const state = waveStateAt(this.clock.timeSeconds, this.waveState);
        const lighting = this.giantWave.lighting;
        return {
            index: state.index,
            phase: state.phaseName,
            phaseLetter: wavePhaseLetters[state.phase],
            secondsIntoPhase: state.secondsIntoPhase,
            phaseSeconds: state.phaseEndSeconds - state.phaseStartSeconds,
            secondsBeforeImpact: state.secondsBeforeImpact,
            impactSeconds: state.impactSeconds,
            schedule: { firstImpact: waveSchedule.firstImpactSeconds, period: waveSchedule.periodSeconds, mountainsLead: waveSchedule.approachSeconds, braceLead: waveSchedule.braceSeconds, underwater: waveSchedule.underwaterSeconds, drain: waveSchedule.drainSeconds },
            frontDistanceMetres: state.frontDistanceMetres,
            visible: this.giantWave.enabled,
            crestAlongMetres: this.giantWave.crestAlong,
            heightMetres: this.giantWave.heightMetres,
            receding: { visible: this.recedingWave.enabled, crestAlongMetres: this.recedingWave.crestAlong, heightMetres: this.recedingWave.heightMetres },
            crestDistanceMetres: lighting.distanceToCrestMetres,
            astronautCrest: this.astronautCrestStats(),
            toward: this.giantWave.toward.slice(),
            lateralOriginMetres: this.giantWave.lateralOrigin,
            crestElevationDegrees: (lighting.crestElevationRadians * 180) / Math.PI,
            keyLightVisibility: lighting.keyVisibility,
            skyVisibility: lighting.skyVisibility,
            cameraUnderwater: this.underwaterView.active,
            impactPosition: this.lastImpact ? [this.lastImpact.x, this.lastImpact.z] : null,
            impactWaveIndex: this.lastImpact ? this.lastImpact.waveIndex : null,
            shipWavesApplied: this.shipWavesApplied,
        };
    }

    astronautCrestStats() {
        const controller = this.suitController;
        const wave = this.giantWave;
        const crest = wave.localCrestAt(controller.positionX, controller.positionZ, {});
        return {
            aheadMetres: crest.aheadMetres,
            heightMetres: crest.heightMetres,
            crestOffsetMetres: crest.crestOffsetMetres,
            absoluteLateralMetres: wave.lateral(controller.positionX, controller.positionZ) + wave.lateralOrigin,
        };
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
        if (this.cameraMode === "player") {
            this.updatePlayer(this.clock.lastDeltaSeconds);
        }
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
        this.anticipateCameraJump(pose);
        this.cameraFrame.setPose(pose.position[0], pose.position[1], pose.position[2], pose.yawRadians, pose.pitchRadians);
        this.cameraFrame.setVerticalFieldOfView(pose.verticalFieldOfViewRadians);
    }

    anticipateCameraJump(pose) {
        const cosinePitch = Math.cos(pose.pitchRadians);
        const forwardX = Math.sin(pose.yawRadians) * cosinePitch;
        const forwardY = Math.sin(pose.pitchRadians);
        const forwardZ = Math.cos(pose.yawRadians) * cosinePitch;
        const previous = this.previousCameraForward;
        const turnCosine = forwardX * previous[0] + forwardY * previous[1] + forwardZ * previous[2];
        if (this.previousCameraForwardValid && turnCosine < cameraJumpCosine) {
            const cut = turnCosine < largeCameraJumpCosine ? largeCameraJumpPreemptiveCut : cameraJumpPreemptiveCut;
            this.resolution.requestPreemptiveCut(cut, "camera jump", cut);
        }
        previous[0] = forwardX;
        previous[1] = forwardY;
        previous[2] = forwardZ;
        this.previousCameraForwardValid = true;
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
        const waveLighting = this.giantWave.lighting;
        uniforms.setVector("waveLightingAndHaze", waveLighting.keyVisibility, waveLighting.skyVisibility, waveLighting.hazeFactor, 0);
        uniforms.setVector("underwaterMediumAndDensity", this.underwaterMedium[0], this.underwaterMedium[1], this.underwaterMedium[2], this.underwaterMedium[3]);
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
        this.cameraRig.shoulderScale = shoulderScaleForAspect(outputWidth / outputHeight);
        this.updateCamera(this.clock.lastDeltaSeconds > 0 ? this.clock.lastDeltaSeconds : Math.min(deltaSeconds, 0.1));
        this.cameraFrame.prepare(outputWidth, outputHeight, this.beautyTargets.internalWidth, this.beautyTargets.internalHeight);
        this.testScene.update(this.clock.timeSeconds, frameIndex);
        this.atmosphere.setCameraPositionMetres(this.cameraFrame.position.x, this.cameraFrame.position.y, this.cameraFrame.position.z);
        const followAstronaut = this.systemsEnabled.astronaut;
        this.rippleCentre[0] = followAstronaut ? this.suitController.positionX : this.cameraFrame.position.x;
        this.rippleCentre[1] = followAstronaut ? this.suitController.positionZ : this.cameraFrame.position.z;
        if (followAstronaut && this.cameraMode === "player") {
            this.suitRenderer.writeSkin(this.suitFigure.skin);
        }
        this.writeAstronautProxies();
        this.sceneProxies.write();
        this.rippleField.updateWindow(this.rippleCentre[0], this.rippleCentre[1]);
        this.seaSurface.setCentre(this.cameraFrame.position.x, this.cameraFrame.position.z);
        this.seaSurface.writeParameters();
        this.updateWave();
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
        this.clockPanel?.update(this.clock.timeSeconds);
        this.waveCountdownPanel?.update(this.waveState.index, this.waveState.secondsBeforeImpact);
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
            const computeReady = this.testScene.patternCompute.isReady() && this.gargantua.isReady() && this.atmosphere.isReady() && this.seaSimulation.isReady() && this.rippleField.isReady();
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
        await this.waitForAllReady([...this.testScene.allMeshes, this.testScene.lateMarkerWarmed, this.skyDome.mesh, this.seaSurface.mesh, ...this.giantWave.meshes, ...this.recedingWave.meshes, this.underwaterView.mesh, ...this.suitRenderer.meshes, ...this.lander.meshesForWarmUp]);
        this.postChain.settings.outputBlack = 1;
        this.renderFrame(performance.now(), 1 / 60);
        await this.device.queue.onSubmittedWorkDone();
        await this.measureAndApplyKeyLight();
        await this.calibrateSeaHeight();
        for (let frameNumber = 0; frameNumber < 4; frameNumber++) {
            this.renderFrame(performance.now(), 1 / 60);
            await this.device.queue.onSubmittedWorkDone();
        }
        const systemsBeforeWarmUp = { ...this.systemsEnabled };
        for (const lateSystem of ["sea", "wave", "testGeometry", "astronaut", "ship"]) {
            this.setSystemEnabled(lateSystem, true);
        }
        for (let frameNumber = 0; frameNumber < 3; frameNumber++) {
            this.renderFrame(performance.now(), 1 / 60);
            await this.device.queue.onSubmittedWorkDone();
        }
        this.forceUnderwaterForWarmUp = true;
        for (let frameNumber = 0; frameNumber < 3; frameNumber++) {
            this.renderFrame(performance.now(), 1 / 60);
            await this.device.queue.onSubmittedWorkDone();
        }
        this.forceUnderwaterForWarmUp = false;
        for (const lateSystem of ["sea", "wave", "testGeometry", "astronaut", "ship"]) {
            this.setSystemEnabled(lateSystem, systemsBeforeWarmUp[lateSystem]);
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
        const earthSeconds = millerSeconds * earthSecondsPerMillerSecond;
        return { millerSeconds, earthSeconds, millerText: formatMillerClock(millerSeconds), earthText: formatEarthClock(millerSeconds) };
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
            recentRenderPipelines: this.pipelineCounters.recentRenderPipelines.slice(-4),
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
                deadlineCuts: this.resolution.deadlineCutCount,
                stepUpsBlockedByRawSpan: this.resolution.stepUpsBlockedByRawSpan,
                lastReason: this.resolution.lastDecisionReason,
                clockSlowdown: this.resolution.lastClockSlowdown,
                normalizedSpanMs: this.resolution.lastNormalizedSpanMilliseconds,
                clockGaugeReferenceMs: this.clockGauge.referenceMilliseconds,
            },
            adapter: { ...this.adapter },
            features: this.enabledFeatureNames.slice(),
            missingFeatures: this.missingRequiredFeatures.slice(),
            deviceLost: this.gpuErrors.deviceLost,
            simTime: this.clock.timeSeconds,
            timeFrozen: this.clock.isFrozen,
            wave: this.waveStats(),
            ship: this.shipStats(),
            astronaut: {
                visible: this.systemsEnabled.astronaut,
                position: [this.suitController.positionX, this.suitController.positionY, this.suitController.positionZ],
                absolutePosition: [this.suitController.positionX + this.worldOriginX, this.suitController.positionY, this.suitController.positionZ + this.worldOriginZ],
                headingDegrees: (this.suitController.facingYaw * 180) / Math.PI,
                horizontalSpeed: this.suitController.planarSpeed,
                gaitMode: ["idle", "walking", "stopping"][this.suitFigure.gaitMode],
                turningInPlace: this.suitController.turningInPlace,
                pelvisHeight: this.suitFigure.pelvisPosition[1] - this.suitController.positionY,
                maximumStanceReachExcessMetres: this.suitFigure.maximumStanceReachExcessMetres,
                braced: this.suitFigure.braceAmount > 0.5,
                braceAmount: this.suitFigure.braceAmount,
                inputLocked: this.suitController.inputLocked,
                wetness: 0,
                triangles: this.suitRenderer.triangleCount,
            },
            feet: this.suitFigure.feet.map((foot) => ({
                side: foot.side < 0 ? "left" : "right",
                inStance: foot.planted,
                stanceSerial: foot.stanceSerial,
                contactMask: foot.contactMask,
                plantPosition: Array.from(foot.plantAnkle),
                plantYawDegrees: (foot.plantYaw * 180) / Math.PI,
                ankle: Array.from(foot.ankle),
                pitchDegrees: (foot.pitch * 180) / Math.PI,
                heel: Array.from(foot.solePoints.subarray(0, 3)),
                mid: Array.from(foot.solePoints.subarray(3, 6)),
                ball: Array.from(foot.solePoints.subarray(6, 9)),
                toe: Array.from(foot.solePoints.subarray(9, 12)),
            })),
            camera: {
                preset: this.viewPreset,
                presetName: cameraPresets[this.cameraRig.presetIndex].name,
                presetChanges: this.cameraRig.presetChangeCount,
                firstPersonAmount: this.cameraRig.firstPersonAmount,
                largestFrameMoveMetres: this.cameraRig.largestFrameMoveMetres,
                rigYawDegrees: (this.cameraRig.yawRadians * 180) / Math.PI,
                rigPitchDegrees: (this.cameraRig.pitchRadians * 180) / Math.PI,
                mode: this.cameraMode,
                scriptedWeight: this.waveCameraWeight,
                shot: this.currentShotName,
                yawDegrees: (cameraFrame.yawRadians * 180) / Math.PI,
                pitchDegrees: (cameraFrame.pitchRadians * 180) / Math.PI,
                distance: this.cameraRig.armLengthMetres,
                focusDistanceMetres: this.cameraRig.focusDistanceMetres,
                fovDegrees: (cameraFrame.verticalFieldOfViewRadians * 180) / Math.PI,
                position: [cameraFrame.position.x, cameraFrame.position.y, cameraFrame.position.z],
                helmet: this.helmetViewStats(),
            },
            clocks: { millerSeconds: clocks.millerSeconds, earthSeconds: clocks.earthSeconds, ratio: earthSecondsPerMillerSecond, millerText: clocks.millerText, earthText: clocks.earthText, panelVisible: Boolean(this.clockPanel && this.clockPanel.panel.style.display !== "none"), panelMillerText: this.clockPanel?.millerText ?? null, panelEarthText: this.clockPanel?.earthText ?? null, countdownVisible: Boolean(this.waveCountdownPanel && this.waveCountdownPanel.panel.style.display !== "none"), panelWaveText: this.waveCountdownPanel?.waveText ?? null, panelCountdownText: this.waveCountdownPanel?.countdownText ?? null },
            audio: { state: this.audioSystem.state, muted: this.audioSystem.muted, outputGain: this.audioSystem.outputGain, muffleCutoffHz: this.audioSystem.muffleCutoffHz },
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
            sea: {
                significantHeightMetres: this.seaSimulation.significantHeightMetres,
                spectrumGain: this.seaSimulation.spectrumGain,
                meanDepthMetres: this.seaSimulation.settings.meanDepthMetres,
                gravity: this.seaSimulation.settings.gravity,
                cascadeSizes: this.seaSimulation.settings.cascadeSizes.slice(),
                surfaceTriangles: this.seaSurface.mesh.triangleCount,
            },
            ripples: {
                stepsTaken: this.rippleField.stepsTaken,
                windowCentre: [...this.rippleField.windowCentre],
                halfExtentMetres: this.rippleField.halfExtentMetres,
                texelMetres: this.rippleField.settings.texelMetres,
            },
            origin: { offset: [this.worldOriginX, 0, this.worldOriginZ], shifts: this.worldOriginShiftCount, shiftDistanceMetres: worldOriginShiftDistanceMetres, shiftStepMetres: worldOriginShiftStepMetres },
            systems: { ...this.systemsEnabled },
        };
    }
}
