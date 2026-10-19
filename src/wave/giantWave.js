import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";
import { wavePath } from "./waveTimeline.js";
import { waveLocalShapeAt } from "./waveLocalShape.js";

export const giantWaveSettings = {
    frontWidthMetres: 350,
    backWidthMetres: 650,
    lateralHalfExtentMetres: 30000,
    glowGain: 2.0,
    raggedMetres: 9,
    lateralSegments: 256,
    acrossSegments: 96,
    skyBlockedByWall: 0.85,
    hazeKeptInShadow: 0.2,
};

function buildWaveGrid(name, scene, lateralSegments, acrossSegments) {
    const positions = [];
    const indices = [];
    for (let row = 0; row <= acrossSegments; row++) {
        for (let column = 0; column <= lateralSegments; column++) {
            positions.push((column / lateralSegments) * 2 - 1, 0, (row / acrossSegments) * 2 - 1);
        }
    }
    const side = lateralSegments + 1;
    for (let row = 0; row < acrossSegments; row++) {
        for (let column = 0; column < lateralSegments; column++) {
            const corner = row * side + column;
            indices.push(corner, corner + 1, corner + side, corner + 1, corner + side + 1, corner + side);
        }
    }
    const mesh = new Mesh(name, scene);
    const vertexData = new VertexData();
    vertexData.positions = positions;
    vertexData.indices = indices;
    vertexData.applyToMesh(mesh, false);
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.doNotSyncBoundingInfo = true;
    mesh.isPickable = false;
    return mesh;
}

function diskFractionBelowLine(offsetInRadii) {
    const t = Math.min(1, Math.max(-1, offsetInRadii));
    return (Math.asin(t) + t * Math.sqrt(1 - t * t)) / Math.PI + 0.5;
}

export class GiantWave {
    constructor({ scene, frameUniforms, atmosphere, toward, name = "giantWave", settings = {} }) {
        this.settings = { ...giantWaveSettings, ...settings };
        const length = Math.hypot(toward[0], toward[1]);
        this.toward = [toward[0] / length, toward[1] / length];
        this.heightMetres = wavePath.heightMetres;
        this.parameters = new UniformBuffer(scene.getEngine(), undefined, false, "waveParameters");
        for (const fieldName of ["crestAlongHeightEnabled", "towardAndWidths", "previousCrestAlongLateralCentreHalfExtent", "glowAndRaggedness", "recedingCrestAlongHeightEnabled"]) {
            this.parameters.addUniform(fieldName, 4);
        }
        this.parameters.create();
        this.material = new ShaderMaterial(name, scene, { vertex: "giantWave", fragment: "giantWave" }, {
            attributes: ["position"],
            uniforms: [],
            shaderLanguage: ShaderLanguage.WGSL,
        });
        this.material.setUniformBuffer("frame", frameUniforms.buffer);
        this.material.setUniformBuffer("waveParameters", this.parameters);
        atmosphere.bindSkyResources(this.material);
        this.material.backFaceCulling = false;
        this.mesh = buildWaveGrid(name, scene, this.settings.lateralSegments, this.settings.acrossSegments);
        this.mesh.material = this.material;
        this.mesh.renderingGroupId = 0;
        this.crestAlong = 0;
        this.previousCrestAlong = 0;
        this.lateralCentre = 0;
        this.lateralOrigin = 0;
        this.localShape = { heightScale: 1, crestOffsetMetres: 0 };
        this.scratchCrest = { aheadMetres: 0, heightMetres: 0, crestOffsetMetres: 0 };
        this.hasPrevious = false;
        this.lighting = { keyVisibility: 1, skyVisibility: 1, hazeFactor: 1, crestElevationRadians: 0, distanceToCrestMetres: Infinity };
        this.motionAmount = 0;
        this.flowSeconds = 0;
        this.recedingReflection = { crestAlong: 0, heightMetres: 0, enabled: false };
        this.setEnabled(false);
    }

    get materials() {
        return [this.material];
    }

    get meshes() {
        return [this.mesh];
    }

    setEnabled(enabled) {
        this.enabled = enabled;
        this.mesh.setEnabled(enabled && this.heightMetres >= 1);
    }

    along(x, z) {
        return x * this.toward[0] + z * this.toward[1];
    }

    lateral(x, z) {
        return x * this.toward[1] - z * this.toward[0];
    }

    place(crestAlong, lateralCentre) {
        this.previousCrestAlong = this.hasPrevious ? this.crestAlong : crestAlong;
        this.crestAlong = crestAlong;
        this.lateralCentre = lateralCentre;
        this.hasPrevious = true;
    }

    setHeightFraction(fraction) {
        this.heightMetres = wavePath.heightMetres * Math.min(1, Math.max(0, fraction));
        this.mesh.setEnabled(this.enabled && this.heightMetres >= 1);
    }

    reflectRecedingWave(recedingWave) {
        const reflection = this.recedingReflection;
        reflection.enabled = recedingWave.enabled;
        reflection.crestAlong = recedingWave.crestAlong;
        reflection.heightMetres = recedingWave.heightMetres;
    }

    discardHistory() {
        this.hasPrevious = false;
    }

    shiftOrigin(deltaX, deltaZ) {
        const alongShift = this.along(deltaX, deltaZ);
        this.crestAlong -= alongShift;
        this.previousCrestAlong -= alongShift;
        this.lateralCentre -= this.lateral(deltaX, deltaZ);
        this.lateralOrigin += this.lateral(deltaX, deltaZ);
    }

    resetOrigin() {
        this.lateralOrigin = 0;
        this.discardHistory();
    }

    localCrestAt(x, z, out) {
        waveLocalShapeAt(this.lateral(x, z) + this.lateralOrigin, this.localShape);
        out.aheadMetres = this.crestAlong - this.localShape.crestOffsetMetres - this.along(x, z);
        out.heightMetres = this.heightMetres * this.localShape.heightScale;
        out.crestOffsetMetres = this.localShape.crestOffsetMetres;
        return out;
    }

    crestOffsetAt(x, z) {
        return waveLocalShapeAt(this.lateral(x, z) + this.lateralOrigin, this.localShape).crestOffsetMetres;
    }

    profileHeightAt(x, crestHeightMetres = this.heightMetres) {
        const front = this.settings.frontWidthMetres;
        const back = this.settings.backWidthMetres;
        if (x >= 0) {
            if (x >= front) {
                return -0.6;
            }
            const remaining = 1 - x / front;
            return crestHeightMetres * remaining * remaining;
        }
        if (-x >= back) {
            return -0.6;
        }
        const remaining = 1 + x / back;
        return crestHeightMetres * remaining * remaining;
    }

    waterHeightAt(x, z) {
        if (!this.enabled) {
            return -Infinity;
        }
        const crest = this.localCrestAt(x, z, this.scratchCrest);
        return this.profileHeightAt(crest.aheadMetres, crest.heightMetres);
    }

    updateLighting(cameraX, cameraY, cameraZ, lightElevationRadians, lightAngularRadiusRadians) {
        const lighting = this.lighting;
        const crest = this.localCrestAt(cameraX, cameraZ, this.scratchCrest);
        const distance = crest.aheadMetres;
        lighting.distanceToCrestMetres = distance;
        if (!this.enabled || distance <= 0) {
            lighting.keyVisibility = 1;
            lighting.skyVisibility = 1;
            lighting.hazeFactor = 1;
            lighting.crestElevationRadians = 0;
            return lighting;
        }
        const elevation = Math.atan2(crest.heightMetres - cameraY, distance);
        lighting.crestElevationRadians = elevation;
        lighting.keyVisibility = 1 - diskFractionBelowLine((elevation - lightElevationRadians) / Math.max(lightAngularRadiusRadians, 1e-3));
        const sine = Math.sin(Math.max(elevation, 0));
        lighting.skyVisibility = 1 - this.settings.skyBlockedByWall * 0.5 * sine * sine;
        lighting.hazeFactor = this.settings.hazeKeptInShadow + (1 - this.settings.hazeKeptInShadow) * lighting.keyVisibility;
        return lighting;
    }

    writeParameters() {
        const parameters = this.parameters;
        const settings = this.settings;
        parameters.updateFloat4("crestAlongHeightEnabled", this.crestAlong, this.heightMetres, this.enabled ? 1 : 0, 0);
        parameters.updateFloat4("towardAndWidths", this.toward[0], this.toward[1], settings.frontWidthMetres, settings.backWidthMetres);
        parameters.updateFloat4("previousCrestAlongLateralCentreHalfExtent", this.previousCrestAlong, this.lateralCentre, settings.lateralHalfExtentMetres, this.lateralOrigin);
        parameters.updateFloat4("glowAndRaggedness", settings.glowGain, settings.raggedMetres, this.motionAmount, this.flowSeconds);
        const receding = this.recedingReflection;
        parameters.updateFloat4("recedingCrestAlongHeightEnabled", receding.crestAlong, receding.heightMetres, receding.enabled ? 1 : 0, 0);
        parameters.update();
    }
}
