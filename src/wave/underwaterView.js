import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";

export const underwaterSettings = {
    mediumAlbedo: [0.05, 0.115, 0.104],
    densityPerMetre: 0.22,
    keyLightKept: 0.18,
    skyLightKept: 0.42,
};

export class UnderwaterView {
    constructor({ scene, frameUniforms, atmosphere, waveParameters, settings = {} }) {
        this.settings = { ...underwaterSettings, ...settings };
        this.material = new ShaderMaterial("underwater", scene, { vertex: "skyDome", fragment: "underwater" }, {
            attributes: ["position"],
            uniforms: [],
            shaderLanguage: ShaderLanguage.WGSL,
        });
        this.material.setUniformBuffer("frame", frameUniforms.buffer);
        this.material.setUniformBuffer("waveParameters", waveParameters);
        atmosphere.bindSkyResources(this.material);
        this.material.backFaceCulling = false;
        this.material.disableDepthWrite = true;
        this.mesh = new Mesh("underwaterTriangle", scene);
        const vertexData = new VertexData();
        vertexData.positions = [-1, -1, 0, 3, -1, 0, -1, 3, 0];
        vertexData.indices = [0, 1, 2];
        vertexData.applyToMesh(this.mesh);
        this.mesh.material = this.material;
        this.mesh.alwaysSelectAsActiveMesh = true;
        this.mesh.isPickable = false;
        this.mesh.renderingGroupId = 1;
        this.active = false;
        this.mesh.setEnabled(false);
    }

    mediumRadiance(skyIrradiance) {
        const albedo = this.settings.mediumAlbedo;
        return [albedo[0] * skyIrradiance[0] / Math.PI, albedo[1] * skyIrradiance[1] / Math.PI, albedo[2] * skyIrradiance[2] / Math.PI];
    }

    setActive(active) {
        this.active = active;
        this.mesh.setEnabled(active);
    }
}
