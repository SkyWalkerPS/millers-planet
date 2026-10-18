import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";
import { buildClipmapMesh, clipmapBaseSpacingMetres, clipmapQuadsPerSide } from "./clipmapMesh.js";
import { defaultSeaSurfaceSettings } from "./seaSurfaceSettings.js";

export { defaultSeaSurfaceSettings };


export class SeaSurface {
    constructor({ scene, frameUniforms, atmosphere, simulation, rippleField, settings = {} }) {
        this.settings = { ...defaultSeaSurfaceSettings, ...settings };
        this.simulation = simulation;
        this.rippleField = rippleField;
        this.centre = [0, 0];
        this.parameters = new UniformBuffer(scene.getEngine(), undefined, false, "seaSurfaceParameters");
        for (const fieldName of [
            "clipmapCentreAndSpacing",
            "cascadeSizes",
            "cascadeInverseSizes",
            "displacementFadeLevelCurvature",
            "slopeOptics",
            "waterAbsorptionAndScattering",
            "waterScatteringColourAndDepth",
            "seabedShape",
            "rippleWindowCentreHalfTexel",
            "seabedRippleMarks",
            "astronautBoundsAndEnabled",
        ]) {
            this.parameters.addUniform(fieldName, 4);
        }
        this.parameters.addUniform("astronautCapsules", 4, 24);
        this.parameters.create();
        this.astronautCapsuleData = new Float32Array(96);
        this.astronautBounds = new Float32Array(4);
        this.material = new ShaderMaterial("seaSurface", scene, { vertex: "seaSurface", fragment: "seaSurface" }, {
            attributes: ["position"],
            uniforms: [],
            shaderLanguage: ShaderLanguage.WGSL,
        });
        this.material.setUniformBuffer("frame", frameUniforms.buffer);
        this.material.setUniformBuffer("seaSurface", this.parameters);
        atmosphere.bindSkyResources(this.material);
        this.material.setTexture("displacementTexture", simulation.displacementTexture);
        this.material.setTexture("derivativeTexture", simulation.derivativeTexture);
        this.material.setTexture("momentTexture", simulation.momentTexture);
        this.material.setTexture("rippleTexture", rippleField.readTexture);
        this.material.backFaceCulling = false;
        this.mesh = buildClipmapMesh("seaSurface", scene);
        this.mesh.material = this.material;
        this.mesh.renderingGroupId = 0;
        this.writeParameters();
    }

    setCentre(x, z) {
        this.centre[0] = x;
        this.centre[1] = z;
    }

    writeParameters() {
        const settings = this.settings;
        const sizes = this.simulation.settings.cascadeSizes;
        const parameters = this.parameters;
        parameters.updateFloat4("clipmapCentreAndSpacing", this.centre[0], this.centre[1], clipmapBaseSpacingMetres, clipmapQuadsPerSide / 2);
        parameters.updateFloat4("cascadeSizes", sizes[0], sizes[1], sizes[2], 0);
        parameters.updateFloat4("cascadeInverseSizes", 1 / sizes[0], 1 / sizes[1], 1 / sizes[2], 0);
        parameters.updateFloat4("displacementFadeLevelCurvature", settings.displacementFadeStartMetres, settings.displacementFadeEndMetres, settings.waterLevelMetres, settings.planetRadiusMetres);
        parameters.updateFloat4("slopeOptics", settings.unresolvedSlopeVariance, settings.reflectionSpreadBiasRadians, settings.refractiveIndex, settings.fresnelNormalSmoothing);
        parameters.updateFloat4("waterAbsorptionAndScattering", settings.absorptionPerMetre[0], settings.absorptionPerMetre[1], settings.absorptionPerMetre[2], settings.scatteringPerMetre);
        parameters.updateFloat4("waterScatteringColourAndDepth", settings.scatteringColour[0], settings.scatteringColour[1], settings.scatteringColour[2], this.simulation.settings.meanDepthMetres);
        parameters.updateFloat4("seabedShape", settings.seabedDepthVariationMetres, settings.seabedFeatureScalePerMetre, settings.seabedDarkAlbedo, settings.seabedLightAlbedo);
        const ripples = this.rippleField;
        parameters.updateFloat4("rippleWindowCentreHalfTexel", ripples.windowCentre[0], ripples.windowCentre[1], ripples.halfExtentMetres, ripples.settings.texelMetres);
        const [waveTravelX, waveTravelZ] = this.simulation.settings.windTravelDirection;
        const waveTravelLength = Math.hypot(waveTravelX, waveTravelZ) || 1;
        parameters.updateFloat4("seabedRippleMarks", settings.seabedRippleMarkAmplitudeMetres, settings.seabedRippleMarkWavelengthMetres, waveTravelX / waveTravelLength, waveTravelZ / waveTravelLength);
        parameters.updateFloat4("astronautBoundsAndEnabled", this.astronautBounds[0], this.astronautBounds[1], this.astronautBounds[2], this.astronautBounds[3]);
        parameters.updateFloatArray("astronautCapsules", this.astronautCapsuleData);
        parameters.update();
    }

    updateSettings(settings = {}) {
        Object.assign(this.settings, settings);
    }
}
