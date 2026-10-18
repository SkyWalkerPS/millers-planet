import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";
import { Constants } from "@babylonjs/core/Engines/constants";

const alongSegments = 192;
const acrossSegments = 48;

function buildGridMesh(name, scene) {
    const positions = [];
    const indices = [];
    for (let row = 0; row <= acrossSegments; row++) {
        for (let column = 0; column <= alongSegments; column++) {
            positions.push(column / alongSegments, 0, row / acrossSegments);
        }
    }
    const side = alongSegments + 1;
    for (let row = 0; row < acrossSegments; row++) {
        for (let column = 0; column < alongSegments; column++) {
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

function buildFullScreenTriangle(name, scene) {
    const mesh = new Mesh(name, scene);
    const vertexData = new VertexData();
    vertexData.positions = [-1, -1, 0, 3, -1, 0, -1, 3, 0];
    vertexData.indices = [0, 1, 2];
    vertexData.applyToMesh(mesh);
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.doNotSyncBoundingInfo = true;
    mesh.isPickable = false;
    return mesh;
}

export class WaveReservation {
    constructor({ scene, frameUniforms, atmosphere, simulation, travelDirection, distanceMetres = 1700, heightMetres = 1200 }) {
        this.travelDirection = travelDirection;
        this.distanceMetres = distanceMetres;
        this.heightMetres = heightMetres;
        this.parameters = new UniformBuffer(scene.getEngine(), undefined, false, "waveReservationParameters");
        for (const fieldName of ["frontCentreAndDistance", "travelDirectionAndHeight", "shapeWidths", "underwaterStrength"]) {
            this.parameters.addUniform(fieldName, 4);
        }
        this.parameters.create();
        this.waveMaterial = new ShaderMaterial("wavePlaceholder", scene, { vertex: "wavePlaceholder", fragment: "wavePlaceholder" }, {
            attributes: ["position"],
            uniforms: [],
            shaderLanguage: ShaderLanguage.WGSL,
        });
        this.waveMaterial.setUniformBuffer("frame", frameUniforms.buffer);
        this.waveMaterial.setUniformBuffer("waveReservation", this.parameters);
        atmosphere.bindSkyResources(this.waveMaterial);
        this.waveMaterial.setTexture("derivativeTexture", simulation.derivativeTexture);
        this.waveMaterial.setTexture("momentTexture", simulation.momentTexture);
        this.waveMaterial.backFaceCulling = false;
        this.waveMesh = buildGridMesh("wavePlaceholder", scene);
        this.waveMesh.material = this.waveMaterial;
        this.waveMesh.renderingGroupId = 0;
        this.underwaterMaterial = new ShaderMaterial("underwaterPlaceholder", scene, { vertex: "skyDome", fragment: "underwaterPlaceholder" }, {
            attributes: ["position"],
            uniforms: [],
            shaderLanguage: ShaderLanguage.WGSL,
            needAlphaBlending: true,
        });
        this.underwaterMaterial.setUniformBuffer("frame", frameUniforms.buffer);
        this.underwaterMaterial.setUniformBuffer("waveReservation", this.parameters);
        atmosphere.bindSkyResources(this.underwaterMaterial);
        this.underwaterMaterial.backFaceCulling = false;
        this.underwaterMaterial.disableDepthWrite = true;
        this.underwaterMaterial.depthFunction = Constants.ALWAYS;
        this.underwaterMaterial.alphaMode = Constants.ALPHA_COMBINE;
        this.underwaterMesh = buildFullScreenTriangle("underwaterPlaceholder", scene);
        this.underwaterMesh.material = this.underwaterMaterial;
        this.underwaterMesh.renderingGroupId = 3;
        this.setEnabled(false);
    }

    get materials() {
        return [this.waveMaterial, this.underwaterMaterial];
    }

    get meshes() {
        return [this.waveMesh, this.underwaterMesh];
    }

    setEnabled(enabled) {
        this.enabled = enabled;
        this.waveMesh.setEnabled(enabled);
        this.underwaterMesh.setEnabled(enabled);
    }

    writeParameters(cameraX, cameraZ) {
        const direction = this.travelDirection;
        this.parameters.updateFloat4("frontCentreAndDistance", cameraX, 0, cameraZ, this.distanceMetres);
        this.parameters.updateFloat4("travelDirectionAndHeight", direction[0], 0, direction[1], this.heightMetres);
        this.parameters.updateFloat4("shapeWidths", 350, 4000, 1400, 0);
        this.parameters.updateFloat4("underwaterStrength", 0.002, 0, 0, 0);
        this.parameters.update();
    }
}
