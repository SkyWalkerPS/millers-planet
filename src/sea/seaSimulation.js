import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";
import { RawTexture2DArray } from "@babylonjs/core/Materials/Textures/rawTexture2DArray";
import { TextureSampler } from "@babylonjs/core/Materials/Textures/textureSampler";
import { Constants } from "@babylonjs/core/Engines/constants";
import { createSingleMipViews, sampledInternalTextureForView, storageTextureForView } from "../gpu/internals.js";

const gridSize = 256;
const cascadeCount = 3;
const texelsPerCascade = gridSize * gridSize;
const spectrumBytes = texelsPerCascade * cascadeCount * 16;
const maximumProbeQueries = 64;

export const defaultSeaSettings = {
    cascadeSizes: [7.43, 1.393, 0.2617],
    cascadeGains: [1.0, 1.0, 0.8],
    meanDepthMetres: 0.2,
    gravity: 12.75,
    surfaceTensionOverDensity: 7.28e-5,
    windSpeed: 5,
    windTravelDirection: [0, -1],
    peakAngularFrequency: 7.54,
    gamma: 3.3,
    phillipsAlpha: 0.0081,
    choppiness: 1.0,
    choppinessDepthCap: 2.0,
    shortWaveCutMetres: 0.0012,
    loopPeriodSeconds: 600,
    seed: 1,
    targetSignificantHeightMetres: 0.035,
    anisotropy: 2,
};

function bandEdges(cascadeSizes) {
    const minimum = [];
    const maximum = [];
    for (let cascade = 0; cascade < cascadeSizes.length; cascade++) {
        const isLast = cascade === cascadeSizes.length - 1;
        maximum.push(isLast ? ((Math.PI * gridSize) / cascadeSizes[cascade]) * 0.98 : (2 * Math.PI * 6) / cascadeSizes[cascade + 1]);
        minimum.push(cascade === 0 ? Math.PI / cascadeSizes[0] : maximum[cascade - 1]);
    }
    return { minimum, maximum };
}

function createSimulationTexture(scene, anisotropy) {
    const texture = new RawTexture2DArray(
        null,
        gridSize,
        gridSize,
        cascadeCount,
        Constants.TEXTUREFORMAT_RGBA,
        scene,
        true,
        false,
        Constants.TEXTURE_TRILINEAR_SAMPLINGMODE,
        Constants.TEXTURETYPE_HALF_FLOAT,
        Constants.TEXTURE_CREATIONFLAG_STORAGE,
    );
    texture.wrapU = Constants.TEXTURE_WRAP_ADDRESSMODE;
    texture.wrapV = Constants.TEXTURE_WRAP_ADDRESSMODE;
    texture.anisotropicFilteringLevel = anisotropy;
    return texture;
}

export class SeaSimulation {
    constructor({ engine, scene, profiler, settings = {} }) {
        this.engine = engine;
        this.scene = scene;
        this.profiler = profiler;
        this.settings = { ...defaultSeaSettings, ...settings };
        this.enabled = true;
        this.spectrumGain = 1;
        this.initialSpectrumPending = true;
        this.testMode = null;
        this.significantHeightMetres = null;
        this.parameters = new UniformBuffer(engine, undefined, false, "seaSimulationParameters");
        for (const fieldName of [
            "cascadeSizes",
            "cascadeMinimumWavenumbers",
            "cascadeMaximumWavenumbers",
            "cascadeGains",
            "windSpeedPeakGammaAlpha",
            "windDirectionAndUnused",
            "choppinessCutLoopSeed",
            "timeDeltaUnusedGain",
            "depthGravityCapSurfaceTension",
            "testModeCascadeIndexAmplitude",
        ]) {
            this.parameters.addUniform(fieldName, 4);
        }
        this.parameters.create();
        this.initialSpectrum = new StorageBuffer(engine, spectrumBytes, Constants.BUFFER_CREATIONFLAG_READWRITE, "seaInitialSpectrum");
        this.spectrumA = new StorageBuffer(engine, spectrumBytes, Constants.BUFFER_CREATIONFLAG_READWRITE, "seaSpectrumA");
        this.spectrumB = new StorageBuffer(engine, spectrumBytes, Constants.BUFFER_CREATIONFLAG_READWRITE, "seaSpectrumB");
        this.temporaryA = new StorageBuffer(engine, spectrumBytes, Constants.BUFFER_CREATIONFLAG_READWRITE, "seaTemporaryA");
        this.temporaryB = new StorageBuffer(engine, spectrumBytes, Constants.BUFFER_CREATIONFLAG_READWRITE, "seaTemporaryB");
        this.displacementTexture = createSimulationTexture(scene, this.settings.anisotropy);
        this.derivativeTexture = createSimulationTexture(scene, this.settings.anisotropy);
        this.momentTexture = createSimulationTexture(scene, this.settings.anisotropy);

        this.initialCompute = new ComputeShader("seaInitialSpectrum", engine, "seaInitialSpectrum", {
            bindingsMapping: { simulation: { group: 0, binding: 0 }, initialSpectrum: { group: 0, binding: 1 } },
        });
        this.initialCompute.setUniformBuffer("simulation", this.parameters);
        this.initialCompute.setStorageBuffer("initialSpectrum", this.initialSpectrum);

        this.evolveCompute = new ComputeShader("seaEvolve", engine, "seaEvolve", {
            bindingsMapping: {
                simulation: { group: 0, binding: 0 },
                initialSpectrum: { group: 0, binding: 1 },
                spectrumA: { group: 0, binding: 2 },
                spectrumB: { group: 0, binding: 3 },
            },
        });
        this.evolveCompute.setUniformBuffer("simulation", this.parameters);
        this.evolveCompute.setStorageBuffer("initialSpectrum", this.initialSpectrum);
        this.evolveCompute.setStorageBuffer("spectrumA", this.spectrumA);
        this.evolveCompute.setStorageBuffer("spectrumB", this.spectrumB);

        this.rowsCompute = new ComputeShader("seaFourierRows", engine, "seaFourierRows", {
            bindingsMapping: {
                inputA: { group: 0, binding: 0 },
                inputB: { group: 0, binding: 1 },
                outputA: { group: 0, binding: 2 },
                outputB: { group: 0, binding: 3 },
            },
        });
        this.rowsCompute.setStorageBuffer("inputA", this.spectrumA);
        this.rowsCompute.setStorageBuffer("inputB", this.spectrumB);
        this.rowsCompute.setStorageBuffer("outputA", this.temporaryA);
        this.rowsCompute.setStorageBuffer("outputB", this.temporaryB);

        this.columnsCompute = new ComputeShader("seaFourierColumns", engine, "seaFourierColumns", {
            bindingsMapping: {
                inputA: { group: 0, binding: 0 },
                inputB: { group: 0, binding: 1 },
                displacementOutput: { group: 0, binding: 2 },
                derivativeOutput: { group: 0, binding: 3 },
                momentOutput: { group: 0, binding: 4 },
            },
        });
        this.columnsCompute.setStorageBuffer("inputA", this.temporaryA);
        this.columnsCompute.setStorageBuffer("inputB", this.temporaryB);
        this.columnsCompute.setStorageTexture("displacementOutput", this.displacementTexture);
        this.columnsCompute.setStorageTexture("derivativeOutput", this.derivativeTexture);
        this.columnsCompute.setStorageTexture("momentOutput", this.momentTexture);

        this.mipComputes = [];
        this.mipViewsReady = false;

        this.probeParameters = new UniformBuffer(engine, undefined, false, "seaProbeParameters");
        this.probeParameters.addUniform("countModeUnused", 4);
        this.probeParameters.addUniform("cascadeInverseSizes", 4);
        this.probeParameters.create();
        this.probeQueries = new StorageBuffer(engine, maximumProbeQueries * 16, Constants.BUFFER_CREATIONFLAG_READWRITE, "seaProbeQueries");
        this.probeResults = new StorageBuffer(engine, maximumProbeQueries * 16, Constants.BUFFER_CREATIONFLAG_READWRITE, "seaProbeResults");
        this.probeQueryData = new Float32Array(maximumProbeQueries * 4);
        this.probeSampler = new TextureSampler().setParameters(
            Constants.TEXTURE_WRAP_ADDRESSMODE,
            Constants.TEXTURE_WRAP_ADDRESSMODE,
            Constants.TEXTURE_WRAP_ADDRESSMODE,
            1,
            Constants.TEXTURE_BILINEAR_SAMPLINGMODE,
        );
        this.probeCompute = new ComputeShader("seaProbe", engine, "seaProbe", {
            bindingsMapping: {
                probe: { group: 0, binding: 0 },
                displacementTexture: { group: 0, binding: 1 },
                queries: { group: 0, binding: 2 },
                results: { group: 0, binding: 3 },
                repeatSampler: { group: 0, binding: 4 },
            },
        });
        this.probeCompute.setUniformBuffer("probe", this.probeParameters);
        this.probeCompute.setTexture("displacementTexture", this.displacementTexture, false);
        this.probeCompute.setStorageBuffer("queries", this.probeQueries);
        this.probeCompute.setStorageBuffer("results", this.probeResults);
        this.probeCompute.setTextureSampler("repeatSampler", this.probeSampler);
        this.pendingProbe = null;

        this.timeSeconds = 0;
        this.writeParameters(0, 0);
    }

    get allComputeShaders() {
        return [this.initialCompute, this.evolveCompute, this.rowsCompute, this.columnsCompute, this.probeCompute, ...this.mipComputes];
    }

    isReady() {
        this.ensureMipComputes();
        return this.allComputeShaders.every((compute) => compute.isReady());
    }

    ensureMipComputes() {
        if (this.mipViewsReady || !this.displacementTexture.getInternalTexture()?._hardwareTexture) {
            return;
        }
        const displacementViews = createSingleMipViews(this.displacementTexture, cascadeCount);
        const derivativeViews = createSingleMipViews(this.derivativeTexture, cascadeCount);
        const momentViews = createSingleMipViews(this.momentTexture, cascadeCount);
        this.mipLevelCount = displacementViews.length;
        for (let level = 1; level < this.mipLevelCount; level++) {
            const compute = new ComputeShader(`seaMipLevel${level}`, this.engine, "seaMipLevel", {
                bindingsMapping: {
                    sourceDisplacement: { group: 0, binding: 0 },
                    sourceDerivatives: { group: 0, binding: 1 },
                    sourceMoments: { group: 0, binding: 2 },
                    destinationDisplacement: { group: 0, binding: 3 },
                    destinationDerivatives: { group: 0, binding: 4 },
                    destinationMoments: { group: 0, binding: 5 },
                },
            });
            compute.setInternalTexture("sourceDisplacement", sampledInternalTextureForView(displacementViews[level - 1]));
            compute.setInternalTexture("sourceDerivatives", sampledInternalTextureForView(derivativeViews[level - 1]));
            compute.setInternalTexture("sourceMoments", sampledInternalTextureForView(momentViews[level - 1]));
            compute.setStorageTexture("destinationDisplacement", storageTextureForView(`seaDisplacementMip${level}`, displacementViews[level]));
            compute.setStorageTexture("destinationDerivatives", storageTextureForView(`seaDerivativesMip${level}`, derivativeViews[level]));
            compute.setStorageTexture("destinationMoments", storageTextureForView(`seaMomentsMip${level}`, momentViews[level]));
            compute.mipSize = gridSize >> level;
            this.mipComputes.push(compute);
        }
        this.mipViewsReady = true;
    }

    writeParameters(timeSeconds, deltaSeconds) {
        const settings = this.settings;
        const parameters = this.parameters;
        const sizes = settings.cascadeSizes;
        const edges = bandEdges(sizes);
        const direction = settings.windTravelDirection;
        const directionLength = Math.hypot(direction[0], direction[1]) || 1;
        const test = this.testMode;
        parameters.updateFloat4("cascadeSizes", sizes[0], sizes[1], sizes[2], 0);
        parameters.updateFloat4("cascadeMinimumWavenumbers", edges.minimum[0], edges.minimum[1], edges.minimum[2], 0);
        parameters.updateFloat4("cascadeMaximumWavenumbers", edges.maximum[0], edges.maximum[1], edges.maximum[2], 0);
        parameters.updateFloat4("cascadeGains", settings.cascadeGains[0], settings.cascadeGains[1], settings.cascadeGains[2], 0);
        parameters.updateFloat4("windSpeedPeakGammaAlpha", settings.windSpeed, settings.peakAngularFrequency, settings.gamma, settings.phillipsAlpha);
        parameters.updateFloat4("windDirectionAndUnused", direction[0] / directionLength, direction[1] / directionLength, 0, 0);
        parameters.updateFloat4("choppinessCutLoopSeed", settings.choppiness, settings.shortWaveCutMetres, settings.loopPeriodSeconds, settings.seed);
        parameters.updateFloat4("timeDeltaUnusedGain", timeSeconds % settings.loopPeriodSeconds, deltaSeconds, 0, this.spectrumGain);
        parameters.updateFloat4("depthGravityCapSurfaceTension", settings.meanDepthMetres, settings.gravity, settings.choppinessDepthCap, settings.surfaceTensionOverDensity);
        parameters.updateFloat4("testModeCascadeIndexAmplitude", test ? 1 : 0, test ? test.cascade : 0, test ? test.modeIndex : 0, test ? test.amplitude : 0);
        parameters.update();
    }

    dispatch(compute, label, x, y, z) {
        this.profiler.explicitLabel = label;
        compute.dispatch(x, y, z);
        this.profiler.explicitLabel = null;
    }

    dispatchFrame(timeSeconds, deltaSeconds) {
        if (!this.enabled) {
            return;
        }
        this.ensureMipComputes();
        this.timeSeconds = timeSeconds;
        this.writeParameters(timeSeconds, deltaSeconds);
        if (this.initialSpectrumPending) {
            this.dispatch(this.initialCompute, "seaInitialSpectrum", gridSize / 16, gridSize / 16, cascadeCount);
            this.initialSpectrumPending = false;
        }
        this.dispatch(this.evolveCompute, "seaEvolve", gridSize / 16, gridSize / 16, cascadeCount);
        this.dispatch(this.rowsCompute, "seaFourierRows", gridSize, 1, cascadeCount);
        this.dispatch(this.columnsCompute, "seaFourierColumns", gridSize, 1, cascadeCount);
        for (const compute of this.mipComputes) {
            const groups = Math.max(1, Math.ceil(compute.mipSize / 8));
            this.dispatch(compute, "seaMips", groups, groups, cascadeCount);
        }
        if (this.pendingProbe) {
            this.dispatchProbe(this.pendingProbe);
        }
    }

    dispatchProbe(probe) {
        const sizes = this.settings.cascadeSizes;
        this.probeParameters.updateFloat4("countModeUnused", probe.count, probe.worldQueries ? 1 : 0, 0, 0);
        this.probeParameters.updateFloat4("cascadeInverseSizes", 1 / sizes[0], 1 / sizes[1], 1 / sizes[2], 0);
        this.probeParameters.update();
        this.probeQueries.update(this.probeQueryData);
        this.dispatch(this.probeCompute, "seaProbe", Math.ceil(probe.count / 64), 1, 1);
        probe.dispatched = true;
        this.pendingProbe = null;
    }

    requestProbe(queries, worldQueries) {
        const count = Math.min(queries.length, maximumProbeQueries);
        for (let index = 0; index < count; index++) {
            const query = queries[index];
            this.probeQueryData[index * 4] = query[0];
            this.probeQueryData[index * 4 + 1] = query[1];
            this.probeQueryData[index * 4 + 2] = query[2] ?? 0;
            this.probeQueryData[index * 4 + 3] = 0;
        }
        this.pendingProbe = { count, worldQueries, dispatched: false };
        return this.pendingProbe;
    }

    async readProbeResults(count) {
        const bytes = await this.probeResults.read(undefined, undefined, undefined, true);
        const values = new Float32Array(bytes.buffer, bytes.byteOffset, count * 4);
        return Array.from({ length: count }, (_, index) => Array.from(values.subarray(index * 4, index * 4 + 4)));
    }

    async measureSignificantHeight() {
        const bytes = await this.initialSpectrum.read(undefined, undefined, undefined, true);
        const values = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
        let variance = 0;
        for (let index = 0; index < values.length; index++) {
            variance += values[index] * values[index];
        }
        return 4 * Math.sqrt(variance);
    }

    angularFrequencyOf(wavenumber) {
        const settings = this.settings;
        const tanhValue = Math.tanh(Math.min(wavenumber * settings.meanDepthMetres, 10));
        return Math.sqrt((settings.gravity * wavenumber + settings.surfaceTensionOverDensity * wavenumber ** 3) * tanhValue);
    }

    requestInitialSpectrum() {
        this.initialSpectrumPending = true;
    }

    updateSettings(settings = {}) {
        Object.assign(this.settings, settings);
        if (settings.anisotropy !== undefined) {
            for (const texture of [this.displacementTexture, this.derivativeTexture, this.momentTexture]) {
                texture.anisotropicFilteringLevel = settings.anisotropy;
            }
        }
        this.requestInitialSpectrum();
    }
}
