import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";

export class SkyDome {
    constructor({ scene, frameUniforms, atmosphere }) {
        this.material = new ShaderMaterial("skyDome", scene, { vertex: "skyDome", fragment: "skyDome" }, {
            attributes: ["position"],
            uniforms: [],
            shaderLanguage: ShaderLanguage.WGSL,
        });
        this.material.setUniformBuffer("frame", frameUniforms.buffer);
        atmosphere.bindSkyResources(this.material);
        this.material.backFaceCulling = false;
        this.material.disableDepthWrite = true;
        this.mesh = new Mesh("skyDomeTriangle", scene);
        const vertexData = new VertexData();
        vertexData.positions = [-1, -1, 0, 3, -1, 0, -1, 3, 0];
        vertexData.indices = [0, 1, 2];
        vertexData.applyToMesh(this.mesh);
        this.mesh.material = this.material;
        this.mesh.alwaysSelectAsActiveMesh = true;
        this.mesh.renderingGroupId = 1;
    }
}
