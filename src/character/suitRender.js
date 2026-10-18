import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Constants } from "@babylonjs/core/Engines/constants";
import { BONE_COUNT } from "./suitSkeleton.js";
import { buildHelmetShellGeometry, buildSuitGeometry, buildVisorGeometry } from "./suitGeometry.js";

const boneTextureWidth = 32;
const boneTextureRows = 8;
const previousRowsOffset = 4;

export const defaultSuitLook = {
    slots: [
        { albedo: [0.6, 0.58, 0.54], roughness: 0.78, metallic: 0, sheen: 0.35, wettable: 1 },
        { albedo: [0.16, 0.19, 0.23], roughness: 0.72, metallic: 0, sheen: 0.3, wettable: 1 },
        { albedo: [0.68, 0.68, 0.66], roughness: 0.32, metallic: 0, sheen: 0, wettable: 0.5 },
        { albedo: [0.055, 0.055, 0.06], roughness: 0.55, metallic: 0, sheen: 0, wettable: 0.6 },
        { albedo: [0.72, 0.72, 0.73], roughness: 0.3, metallic: 1, sheen: 0, wettable: 0.3 },
        { albedo: [0.5, 0.48, 0.45], roughness: 0.82, metallic: 0, sheen: 0.35, wettable: 1 },
        { albedo: [0.6, 0.58, 0.54], roughness: 0.6, metallic: 0, sheen: 0, wettable: 0.6 },
        { albedo: [0.5, 0.5, 0.5], roughness: 0.6, metallic: 0, sheen: 0, wettable: 1 },
    ],
    wetAll: 0,
    wetBandMetres: 0.12,
    seaBounceFraction: 0.06,
    visorTint: [0.06, 0.05, 0.04],
    visorRoughness: 0.03,
    visorBaseReflectance: [0.62, 0.53, 0.38],
};

function createSkinnedMesh(name, scene, geometry, material) {
    const mesh = new Mesh(name, scene);
    const vertexData = new VertexData();
    vertexData.positions = geometry.positions;
    vertexData.normals = geometry.normals;
    vertexData.uvs = geometry.uvs;
    vertexData.indices = geometry.indices;
    vertexData.applyToMesh(mesh, false);
    mesh.setVerticesData("suitAux", geometry.aux, false, 2);
    mesh.setVerticesData("suitBones", geometry.boneIndices, false, 4);
    mesh.setVerticesData("suitWeights", geometry.boneWeights, false, 4);
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.isPickable = false;
    mesh.freezeWorldMatrix();
    mesh.doNotSyncBoundingInfo = true;
    mesh.material = material;
    mesh.renderingGroupId = 0;
    return mesh;
}

export class SuitRenderer {
    constructor({ scene, engine, frameUniforms, atmosphere, look = {} }) {
        this.look = { ...defaultSuitLook, ...look };
        this.boneData = new Float32Array(boneTextureWidth * boneTextureRows * 4);
        this.boneTexture = RawTexture.CreateRGBATexture(this.boneData, boneTextureWidth, boneTextureRows, scene, false, false, Constants.TEXTURE_NEAREST_SAMPLINGMODE, Constants.TEXTURETYPE_FLOAT);
        this.boneTexture.name = "suitBoneTexture";
        this.parameters = new UniformBuffer(engine, undefined, false, "suitMaterialParameters");
        this.parameters.addUniform("slotAlbedoAndRoughness", 4, 8);
        this.parameters.addUniform("slotMetalSheenWeaveWet", 4, 8);
        this.parameters.addUniform("waterLevelWetAllWetBandSeaBounce", 4);
        this.parameters.addUniform("visorTintAndRoughness", 4);
        this.parameters.addUniform("visorBaseReflectance", 4);
        this.parameters.create();
        this.slotSurfaceData = new Float32Array(32);
        this.slotPropertyData = new Float32Array(32);
        const attributes = ["position", "normal", "uv", "suitAux", "suitBones", "suitWeights"];
        this.suitMaterial = new ShaderMaterial("suit", scene, { vertex: "suit", fragment: "suit" }, { attributes, uniforms: [], shaderLanguage: ShaderLanguage.WGSL });
        this.visorMaterial = new ShaderMaterial("visor", scene, { vertex: "suit", fragment: "visor" }, { attributes, uniforms: [], shaderLanguage: ShaderLanguage.WGSL });
        for (const material of [this.suitMaterial, this.visorMaterial]) {
            material.setUniformBuffer("frame", frameUniforms.buffer);
            material.setUniformBuffer("suitMaterial", this.parameters);
            material.setTexture("suitBoneTexture", this.boneTexture);
            atmosphere.bindSkyResources(material);
            material.backFaceCulling = false;
        }
        const body = buildSuitGeometry();
        const helmet = buildHelmetShellGeometry();
        const visor = buildVisorGeometry();
        this.bodyMesh = createSkinnedMesh("suitBody", scene, body, this.suitMaterial);
        this.helmetMesh = createSkinnedMesh("suitHelmet", scene, helmet, this.suitMaterial);
        this.visorMesh = createSkinnedMesh("suitVisor", scene, visor, this.visorMaterial);
        this.triangleCount = body.triangleCount + helmet.triangleCount + visor.triangleCount;
        this.hasPreviousSkin = false;
        this.visible = true;
        this.firstPerson = false;
        this.waterLevelMetres = 0;
        this.writeParameters();
    }

    get materials() {
        return [this.suitMaterial, this.visorMaterial];
    }

    get meshes() {
        return [this.bodyMesh, this.helmetMesh, this.visorMesh];
    }

    discardPreviousSkin() {
        this.hasPreviousSkin = false;
    }

    writeSkin(skin) {
        const data = this.boneData;
        const rowStride = boneTextureWidth * 4;
        for (let bone = 0; bone < BONE_COUNT; bone++) {
            for (let column = 0; column < 4; column++) {
                const currentOffset = column * rowStride + bone * 4;
                const previousOffset = (column + previousRowsOffset) * rowStride + bone * 4;
                for (let component = 0; component < 4; component++) {
                    const value = skin[bone * 16 + column * 4 + component];
                    data[previousOffset + component] = this.hasPreviousSkin ? data[currentOffset + component] : value;
                    data[currentOffset + component] = value;
                }
            }
        }
        this.hasPreviousSkin = true;
        this.boneTexture.update(data);
    }

    setVisible(visible) {
        this.visible = visible;
        this.applyVisibility();
    }

    setFirstPerson(firstPerson) {
        this.firstPerson = firstPerson;
        this.applyVisibility();
    }

    applyVisibility() {
        this.bodyMesh.setEnabled(this.visible);
        this.helmetMesh.setEnabled(this.visible && !this.firstPerson);
        this.visorMesh.setEnabled(this.visible && !this.firstPerson);
    }

    updateLook(look = {}) {
        Object.assign(this.look, look);
        this.writeParameters();
    }

    writeParameters() {
        const look = this.look;
        for (let slot = 0; slot < 8; slot++) {
            const entry = look.slots[slot];
            this.slotSurfaceData.set([entry.albedo[0], entry.albedo[1], entry.albedo[2], entry.roughness], slot * 4);
            this.slotPropertyData.set([entry.metallic, entry.sheen, 0, entry.wettable], slot * 4);
        }
        const parameters = this.parameters;
        parameters.updateFloatArray("slotAlbedoAndRoughness", this.slotSurfaceData);
        parameters.updateFloatArray("slotMetalSheenWeaveWet", this.slotPropertyData);
        parameters.updateFloat4("waterLevelWetAllWetBandSeaBounce", this.waterLevelMetres, look.wetAll, look.wetBandMetres, look.seaBounceFraction);
        parameters.updateFloat4("visorTintAndRoughness", look.visorTint[0], look.visorTint[1], look.visorTint[2], look.visorRoughness);
        parameters.updateFloat4("visorBaseReflectance", look.visorBaseReflectance[0], look.visorBaseReflectance[1], look.visorBaseReflectance[2], 0);
        parameters.update();
    }
}
