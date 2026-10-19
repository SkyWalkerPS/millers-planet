import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { RawTexture3D } from "@babylonjs/core/Materials/Textures/rawTexture3D";
import { Constants } from "@babylonjs/core/Engines/constants";

const workgroupEdge = 8;
const transmittanceSize = [256, 64];
const multipleScatteringSize = [32, 32];
const skyViewSize = [256, 144];
const aerialPerspectiveSize = 32;
const earthRayleighScatteringPerKilometre = [5.802e-3, 13.558e-3, 33.1e-3];
const earthOzoneAbsorptionPerKilometre = [0.65e-3, 1.881e-3, 0.085e-3];

export const defaultAtmosphereSettings = {
    rayleighScale: 0.8,
    rayleighScaleHeightKilometres: 8,
    mieScatteringPerKilometre: 0.05,
    mieSingleScatteringAlbedo: 0.97,
    mieScaleHeightKilometres: 1.2,
    mieAsymmetry: 0.7,
    marineRelativeDensity: 2.0,
    marineScaleHeightKilometres: 0.4,
    groundAlbedo: 0.1,
    groundRadiusKilometres: 6360,
    topRadiusKilometres: 6460,
};

export const defaultCloudSettings = {
    textureWidth: 4096,
    textureHeight: 1024,
    altitudeKilometres: 1.5,
    overcastCoverage: 0.95,
    clearingCoverage: 0.0,
    clearingInnerDegrees: 16,
    clearingOuterDegrees: 45,
    meanOpticalDepth: 10,
    brightnessGain: 8.5,
    directLightPower: 1.5,
    underDeckAmbientGain: 1.0,
    featureScalePerKilometre: 1.0,
    driftKilometres: 0,
    edgeSoftness: 0.6,
    detailAmplitude: 0.9,
    forwardScatteringGain: 0.6,
    rimGain: 0.1,
    skyAmbientGain: 0.32,
    massesAmplitude: 0.8,
    blobContrast: 0.85,
    blobScale: 1.6,
};

function createStorageTexture2D(scene, width, height, wrapU, samplingMode = Constants.TEXTURE_BILINEAR_SAMPLINGMODE, withMipmaps = false) {
    const texture = new RawTexture(null, width, height, Constants.TEXTUREFORMAT_RGBA, scene, withMipmaps, false, samplingMode, Constants.TEXTURETYPE_HALF_FLOAT, Constants.TEXTURE_CREATIONFLAG_STORAGE);
    texture.wrapU = wrapU;
    texture.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
    return texture;
}

function createVectorUniformBuffer(engine, name, fieldNames) {
    const buffer = new UniformBuffer(engine, undefined, false, name);
    for (const fieldName of fieldNames) {
        buffer.addUniform(fieldName, 4);
    }
    buffer.create();
    return buffer;
}

export class AtmosphereSystem {
    constructor({ engine, scene, profiler, frameUniforms, settings = {}, cloudSettings = {} }) {
        this.engine = engine;
        this.scene = scene;
        this.profiler = profiler;
        this.settings = { ...defaultAtmosphereSettings, ...settings };
        this.cloudSettings = { ...defaultCloudSettings, ...cloudSettings };
        this.lightDirection = [0, 0.31, 0.95];
        this.lightIlluminance = [1, 1, 1];
        this.cameraAltitudeKilometres = 0.0017;
        this.cameraPositionKilometres = [0, 0.0017, 0];
        this.cloudBakeOriginKilometres = [0, 0.0017, 0];
        this.enabled = true;
        this.staticRebuildPending = true;
        this.skyViewRebuildPending = true;
        this.cloudRebuildPending = true;
        this.staticRebuildCount = 0;
        this.cloudBakeCount = 0;
        this.parameters = createVectorUniformBuffer(engine, "atmosphereParameters", [
            "rayleighScatteringAndScaleHeight",
            "mieScatteringExtinctionScaleHeightAsymmetry",
            "ozoneAbsorptionAndPeakHeight",
            "groundRadiusTopRadiusAlbedoMarineDensity",
            "lightDirectionAndCameraAltitude",
            "lightIlluminanceAndMarineScaleHeight",
            "deckAltitudeOpticalDepthBrightnessDirectPower",
            "deckClearingCoverageInnerOuterOvercast",
            "deckAmbientGainAndBakeOriginKilometres",
        ]);
        this.cloudParameters = createVectorUniformBuffer(engine, "cloudDeckParameters", [
            "shapeScaleDriftSoftnessDetail",
            "lightingForwardRimAmbientMasses",
            "texelRadiansBlobContrastBlobScale",
        ]);
        this.transmittanceLut = createStorageTexture2D(scene, ...transmittanceSize, Constants.TEXTURE_CLAMP_ADDRESSMODE);
        this.multipleScatteringLut = createStorageTexture2D(scene, ...multipleScatteringSize, Constants.TEXTURE_CLAMP_ADDRESSMODE);
        this.skyViewLut = createStorageTexture2D(scene, ...skyViewSize, Constants.TEXTURE_CLAMP_ADDRESSMODE);
        this.cloudDeckTexture = createStorageTexture2D(scene, this.cloudSettings.textureWidth, this.cloudSettings.textureHeight, Constants.TEXTURE_WRAP_ADDRESSMODE, Constants.TEXTURE_TRILINEAR_SAMPLINGMODE, true);
        this.aerialPerspectiveVolume = new RawTexture3D(
            null,
            aerialPerspectiveSize,
            aerialPerspectiveSize,
            aerialPerspectiveSize,
            Constants.TEXTUREFORMAT_RGBA,
            scene,
            false,
            false,
            Constants.TEXTURE_BILINEAR_SAMPLINGMODE,
            Constants.TEXTURETYPE_HALF_FLOAT,
            Constants.TEXTURE_CREATIONFLAG_STORAGE,
        );
        this.aerialPerspectiveVolume.wrapU = Constants.TEXTURE_CLAMP_ADDRESSMODE;
        this.aerialPerspectiveVolume.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
        this.aerialPerspectiveVolume.wrapR = Constants.TEXTURE_CLAMP_ADDRESSMODE;
        this.transmittanceCompute = new ComputeShader("transmittanceLut", engine, "transmittanceLut", {
            bindingsMapping: { atmosphere: { group: 0, binding: 0 }, transmittanceOutput: { group: 0, binding: 1 } },
        });
        this.transmittanceCompute.setUniformBuffer("atmosphere", this.parameters);
        this.transmittanceCompute.setStorageTexture("transmittanceOutput", this.transmittanceLut);
        this.multipleScatteringCompute = new ComputeShader("multipleScatteringLut", engine, "multipleScatteringLut", {
            bindingsMapping: { atmosphere: { group: 0, binding: 0 }, transmittanceLut: { group: 0, binding: 2 }, multipleScatteringOutput: { group: 0, binding: 3 } },
        });
        this.multipleScatteringCompute.setUniformBuffer("atmosphere", this.parameters);
        this.multipleScatteringCompute.setTexture("transmittanceLut", this.transmittanceLut, true);
        this.multipleScatteringCompute.setStorageTexture("multipleScatteringOutput", this.multipleScatteringLut);
        this.skyViewCompute = new ComputeShader("skyViewLut", engine, "skyViewLut", {
            bindingsMapping: {
                atmosphere: { group: 0, binding: 0 },
                transmittanceLut: { group: 0, binding: 2 },
                multipleScatteringLut: { group: 0, binding: 3 },
                skyViewOutput: { group: 0, binding: 4 },
            },
        });
        this.skyViewCompute.setUniformBuffer("atmosphere", this.parameters);
        this.skyViewCompute.setTexture("transmittanceLut", this.transmittanceLut, true);
        this.skyViewCompute.setTexture("multipleScatteringLut", this.multipleScatteringLut, false);
        this.skyViewCompute.setStorageTexture("skyViewOutput", this.skyViewLut);
        this.aerialPerspectiveCompute = new ComputeShader("aerialPerspective", engine, "aerialPerspective", {
            bindingsMapping: {
                atmosphere: { group: 0, binding: 0 },
                transmittanceLut: { group: 0, binding: 2 },
                multipleScatteringLut: { group: 0, binding: 3 },
                aerialPerspectiveOutput: { group: 0, binding: 4 },
                frame: { group: 0, binding: 5 },
            },
        });
        this.aerialPerspectiveCompute.setUniformBuffer("atmosphere", this.parameters);
        this.aerialPerspectiveCompute.setTexture("transmittanceLut", this.transmittanceLut, true);
        this.aerialPerspectiveCompute.setTexture("multipleScatteringLut", this.multipleScatteringLut, false);
        this.aerialPerspectiveCompute.setStorageTexture("aerialPerspectiveOutput", this.aerialPerspectiveVolume);
        this.aerialPerspectiveCompute.setUniformBuffer("frame", frameUniforms.buffer);
        this.cloudCompute = new ComputeShader("cloudDeck", engine, "cloudDeck", {
            bindingsMapping: {
                atmosphere: { group: 0, binding: 0 },
                transmittanceLut: { group: 0, binding: 2 },
                skyViewLut: { group: 0, binding: 3 },
                cloudDeckOutput: { group: 0, binding: 4 },
                cloudDeck: { group: 0, binding: 5 },
                multipleScatteringLut: { group: 0, binding: 6 },
            },
        });
        this.cloudCompute.setUniformBuffer("atmosphere", this.parameters);
        this.cloudCompute.setTexture("transmittanceLut", this.transmittanceLut, true);
        this.cloudCompute.setTexture("skyViewLut", this.skyViewLut, false);
        this.cloudCompute.setStorageTexture("cloudDeckOutput", this.cloudDeckTexture);
        this.cloudCompute.setUniformBuffer("cloudDeck", this.cloudParameters);
        this.cloudCompute.setTexture("multipleScatteringLut", this.multipleScatteringLut, false);
        this.writeParameters();
    }

    get allComputeShaders() {
        return [this.transmittanceCompute, this.multipleScatteringCompute, this.skyViewCompute, this.aerialPerspectiveCompute, this.cloudCompute];
    }

    isReady() {
        return this.allComputeShaders.every((compute) => compute.isReady());
    }

    setLight(direction, illuminance) {
        this.lightDirection = [direction[0], direction[1], direction[2]];
        this.lightIlluminance = [illuminance[0], illuminance[1], illuminance[2]];
        this.requestFullRebuild();
    }

    updateSettings(atmosphereSettings = {}, cloudSettings = {}) {
        Object.assign(this.settings, atmosphereSettings);
        const { textureWidth, textureHeight, ...adjustableCloudSettings } = cloudSettings;
        Object.assign(this.cloudSettings, adjustableCloudSettings);
        this.requestFullRebuild();
    }

    setCameraPositionMetres(x, y, z) {
        const position = this.cameraPositionKilometres;
        position[0] = x * 0.001;
        position[1] = y * 0.001;
        position[2] = z * 0.001;
        const kilometres = Math.max(y, 1) * 0.001;
        if (Math.abs(kilometres - this.cameraAltitudeKilometres) > 0.0005) {
            this.cameraAltitudeKilometres = kilometres;
            this.skyViewRebuildPending = true;
        }
    }

    shiftOrigin(deltaX, deltaZ) {
        this.cameraPositionKilometres[0] -= deltaX * 0.001;
        this.cameraPositionKilometres[2] -= deltaZ * 0.001;
        this.cloudBakeOriginKilometres[0] -= deltaX * 0.001;
        this.cloudBakeOriginKilometres[2] -= deltaZ * 0.001;
        this.writeParameters();
    }

    requestFullRebuild() {
        this.staticRebuildPending = true;
        this.skyViewRebuildPending = true;
        this.cloudRebuildPending = true;
    }

    writeParameters() {
        const settings = this.settings;
        const parameters = this.parameters;
        const rayleigh = earthRayleighScatteringPerKilometre.map((value) => value * settings.rayleighScale);
        parameters.updateFloat4("rayleighScatteringAndScaleHeight", rayleigh[0], rayleigh[1], rayleigh[2], settings.rayleighScaleHeightKilometres);
        parameters.updateFloat4(
            "mieScatteringExtinctionScaleHeightAsymmetry",
            settings.mieScatteringPerKilometre,
            settings.mieScatteringPerKilometre / settings.mieSingleScatteringAlbedo,
            settings.mieScaleHeightKilometres,
            settings.mieAsymmetry,
        );
        parameters.updateFloat4("ozoneAbsorptionAndPeakHeight", earthOzoneAbsorptionPerKilometre[0], earthOzoneAbsorptionPerKilometre[1], earthOzoneAbsorptionPerKilometre[2], 25);
        parameters.updateFloat4("groundRadiusTopRadiusAlbedoMarineDensity", settings.groundRadiusKilometres, settings.topRadiusKilometres, settings.groundAlbedo, settings.marineRelativeDensity);
        parameters.updateFloat4("lightDirectionAndCameraAltitude", this.lightDirection[0], this.lightDirection[1], this.lightDirection[2], this.cameraAltitudeKilometres);
        parameters.updateFloat4("lightIlluminanceAndMarineScaleHeight", this.lightIlluminance[0], this.lightIlluminance[1], this.lightIlluminance[2], settings.marineScaleHeightKilometres);
        const clouds = this.cloudSettings;
        parameters.updateFloat4("deckAltitudeOpticalDepthBrightnessDirectPower", clouds.altitudeKilometres, clouds.meanOpticalDepth, clouds.brightnessGain, clouds.directLightPower);
        parameters.updateFloat4(
            "deckClearingCoverageInnerOuterOvercast",
            clouds.clearingCoverage,
            (clouds.clearingInnerDegrees * Math.PI) / 180,
            (clouds.clearingOuterDegrees * Math.PI) / 180,
            clouds.overcastCoverage,
        );
        const origin = this.cloudBakeOriginKilometres;
        parameters.updateFloat4("deckAmbientGainAndBakeOriginKilometres", clouds.underDeckAmbientGain, origin[0], origin[1], origin[2]);
        parameters.update();
        const cloudParameters = this.cloudParameters;
        cloudParameters.updateFloat4("shapeScaleDriftSoftnessDetail", clouds.featureScalePerKilometre, clouds.driftKilometres, clouds.edgeSoftness, clouds.detailAmplitude);
        cloudParameters.updateFloat4("lightingForwardRimAmbientMasses", clouds.forwardScatteringGain, clouds.rimGain, clouds.skyAmbientGain, clouds.massesAmplitude);
        cloudParameters.updateFloat4("texelRadiansBlobContrastBlobScale", (2 * Math.PI) / clouds.textureWidth, clouds.blobContrast, clouds.blobScale, 0);
        cloudParameters.update();
    }

    dispatch(compute, label, x, y) {
        this.profiler.explicitLabel = label;
        compute.dispatch(x, y, 1);
        this.profiler.explicitLabel = null;
    }

    dispatchFrame() {
        if (!this.enabled) {
            return;
        }
        if (this.cloudRebuildPending) {
            const origin = this.cloudBakeOriginKilometres;
            const camera = this.cameraPositionKilometres;
            origin[0] = camera[0];
            origin[1] = this.cameraAltitudeKilometres;
            origin[2] = camera[2];
        }
        if (this.staticRebuildPending || this.skyViewRebuildPending || this.cloudRebuildPending) {
            this.writeParameters();
        }
        if (this.staticRebuildPending) {
            this.dispatch(this.transmittanceCompute, "atmosphereTransmittance", transmittanceSize[0] / workgroupEdge, transmittanceSize[1] / workgroupEdge);
            this.dispatch(this.multipleScatteringCompute, "atmosphereMultipleScattering", multipleScatteringSize[0] / workgroupEdge, multipleScatteringSize[1] / workgroupEdge);
            this.staticRebuildPending = false;
            this.staticRebuildCount++;
        }
        if (this.skyViewRebuildPending) {
            this.dispatch(this.skyViewCompute, "atmosphereSkyView", skyViewSize[0] / workgroupEdge, skyViewSize[1] / workgroupEdge);
            this.skyViewRebuildPending = false;
        }
        if (this.cloudRebuildPending) {
            this.dispatch(this.cloudCompute, "cloudDeckBake", this.cloudSettings.textureWidth / workgroupEdge, this.cloudSettings.textureHeight / workgroupEdge);
            this.profiler.explicitLabel = "cloudDeckMips";
            this.engine.generateMipmaps(this.cloudDeckTexture.getInternalTexture());
            this.profiler.explicitLabel = null;
            this.cloudRebuildPending = false;
            this.cloudBakeCount++;
        }
        this.dispatch(this.aerialPerspectiveCompute, "aerialPerspective", aerialPerspectiveSize / workgroupEdge, aerialPerspectiveSize / workgroupEdge);
    }

    bindSkyResources(material) {
        material.setUniformBuffer("atmosphere", this.parameters);
        material.setTexture("transmittanceLut", this.transmittanceLut);
        material.setTexture("skyViewLut", this.skyViewLut);
        material.setTexture("cloudDeckTexture", this.cloudDeckTexture);
        material.setTexture("aerialPerspectiveVolume", this.aerialPerspectiveVolume);
    }
}
