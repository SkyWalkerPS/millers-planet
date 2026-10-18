import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { CreateGround } from "@babylonjs/core/Meshes/Builders/groundBuilder";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";
import { Constants } from "@babylonjs/core/Engines/constants";
import { Matrix, Vector4 } from "@babylonjs/core/Maths/math.vector";

const patternTextureSize = 1024;

function createSurfaceMaterial(scene, name, frameUniforms, patternTexture, tint, metresPerRepeat) {
    const material = new ShaderMaterial(name, scene, { vertex: "testSurface", fragment: "testSurface" }, {
        attributes: ["position", "normal"],
        uniforms: ["world", "previousWorld", "albedoTint", "patternMetresPerRepeat"],
        samplers: ["patternTexture"],
        shaderLanguage: ShaderLanguage.WGSL,
    });
    material.setUniformBuffer("frame", frameUniforms.buffer);
    material.setTexture("patternTexture", patternTexture);
    material.setVector4("albedoTint", new Vector4(tint[0], tint[1], tint[2], 1));
    material.setFloat("patternMetresPerRepeat", metresPerRepeat);
    return material;
}

export class TestScene {
    constructor({ scene, engine, frameUniforms, profiler }) {
        this.scene = scene;
        this.engine = engine;
        this.profiler = profiler;
        this.patternEnabled = true;
        this.sceneGeometryEnabled = true;
        this.heavyPatternIterations = 0;
        this.solidColourMode = 0;
        this.boxesFollowTime = true;
        this.patternTexture = new RawTexture(
            null,
            patternTextureSize,
            patternTextureSize,
            Constants.TEXTUREFORMAT_RGBA,
            scene,
            false,
            false,
            Constants.TEXTURE_BILINEAR_SAMPLINGMODE,
            Constants.TEXTURETYPE_HALF_FLOAT,
            Constants.TEXTURE_CREATIONFLAG_STORAGE,
        );
        this.patternTexture.wrapU = Constants.TEXTURE_WRAP_ADDRESSMODE;
        this.patternTexture.wrapV = Constants.TEXTURE_WRAP_ADDRESSMODE;
        this.patternParameters = new UniformBuffer(engine, undefined, false, "testPatternParameters");
        this.patternParameters.addUniform("timeSeconds", 1);
        this.patternParameters.addUniform("frameIndex", 1);
        this.patternParameters.addUniform("heavyIterations", 1);
        this.patternParameters.addUniform("solidColourMode", 1);
        this.patternParameters.create();
        this.patternCompute = new ComputeShader("testPattern", engine, "testPattern", {
            bindingsMapping: {
                patternTexture: { group: 0, binding: 0 },
                parameters: { group: 0, binding: 1 },
            },
        });
        this.patternCompute.setStorageTexture("patternTexture", this.patternTexture);
        this.patternCompute.setUniformBuffer("parameters", this.patternParameters);

        this.skyMaterial = new ShaderMaterial("testSky", scene, { vertex: "testSky", fragment: "testSky" }, {
            attributes: ["position"],
            uniforms: [],
            shaderLanguage: ShaderLanguage.WGSL,
        });
        this.skyMaterial.setUniformBuffer("frame", frameUniforms.buffer);
        this.skyMaterial.backFaceCulling = false;
        this.skyMaterial.disableDepthWrite = true;
        this.skyMesh = new Mesh("testSkyTriangle", scene);
        const skyVertexData = new VertexData();
        skyVertexData.positions = [-1, -1, 0, 3, -1, 0, -1, 3, 0];
        skyVertexData.indices = [0, 1, 2];
        skyVertexData.applyToMesh(this.skyMesh);
        this.skyMesh.material = this.skyMaterial;
        this.skyMesh.alwaysSelectAsActiveMesh = true;
        this.skyMesh.renderingGroupId = 1;

        this.groundMesh = CreateGround("testGround", { width: 400, height: 400, subdivisions: 1 }, scene);
        this.groundMaterial = createSurfaceMaterial(scene, "testGroundMaterial", frameUniforms, this.patternTexture, [1, 1, 1], 4);
        this.groundMaterial.setMatrix("previousWorld", this.groundMesh.computeWorldMatrix(true));
        this.groundMesh.material = this.groundMaterial;

        this.pillarMesh = CreateBox("testPillar", { width: 1.2, depth: 1.2, height: 30 }, scene);
        this.pillarMesh.position.set(-6, 15, 40);
        this.pillarMaterial = createSurfaceMaterial(scene, "testPillarMaterial", frameUniforms, this.patternTexture, [0.9, 0.86, 0.8], 2);
        this.pillarMaterial.setMatrix("previousWorld", this.pillarMesh.computeWorldMatrix(true));
        this.pillarMesh.material = this.pillarMaterial;

        this.movingBoxes = [];
        const boxTints = [[0.9, 0.35, 0.25], [0.3, 0.75, 0.45], [0.3, 0.45, 0.9], [0.85, 0.8, 0.3]];
        for (let boxIndex = 0; boxIndex < 4; boxIndex++) {
            const mesh = CreateBox(`testMovingBox${boxIndex}`, { size: 1.6 }, scene);
            const material = createSurfaceMaterial(scene, `testMovingBoxMaterial${boxIndex}`, frameUniforms, this.patternTexture, boxTints[boxIndex], 1.6);
            const previousWorldMatrix = new Matrix();
            material.setMatrix("previousWorld", previousWorldMatrix);
            mesh.material = material;
            this.movingBoxes.push({ mesh, material, previousWorldMatrix, orbitRadius: 6 + boxIndex * 3, orbitSpeed: 0.6 - boxIndex * 0.11, phase: boxIndex * 1.7 });
        }
        this.lateMarkerWarmed = this.createLateMarker(scene, frameUniforms, "spikeLateMarkerWarmed", [], [0.2, 0.9, 0.9], -3);
        this.lateMarkerUnwarmed = this.createLateMarker(scene, frameUniforms, "spikeLateMarkerUnwarmed", ["#define LATE_MARKER_UNWARMED"], [0.9, 0.2, 0.9], 3);
        this.lateMarkerUnwarmed.setEnabled(false);
        this.placeMovingBoxes(0);
        for (const box of this.movingBoxes) {
            box.mesh.computeWorldMatrix(true);
            box.previousWorldMatrix.copyFrom(box.mesh.getWorldMatrix());
        }
        this.timeSeconds = 0;
        this.frameIndex = 0;
        scene.onBeforeRenderObservable.add(() => this.dispatchCompute());
    }

    createLateMarker(scene, frameUniforms, name, defines, colour, offsetX) {
        const material = new ShaderMaterial(`${name}Material`, scene, { vertex: "spikeLateMarker", fragment: "spikeLateMarker" }, {
            attributes: ["position"],
            uniforms: ["world", "markerColour"],
            defines,
            shaderLanguage: ShaderLanguage.WGSL,
        });
        material.setUniformBuffer("frame", frameUniforms.buffer);
        material.setVector4("markerColour", new Vector4(colour[0], colour[1], colour[2], 1));
        const mesh = CreateBox(name, { size: 1.0 }, scene);
        mesh.position.set(offsetX, 0.5, 6);
        mesh.material = material;
        return mesh;
    }

    get allMaterials() {
        return [this.skyMaterial, this.groundMaterial, this.pillarMaterial, ...this.movingBoxes.map((box) => box.material)];
    }

    get allMeshes() {
        return [this.skyMesh, this.groundMesh, this.pillarMesh, ...this.movingBoxes.map((box) => box.mesh)];
    }

    placeMovingBoxes(timeSeconds) {
        for (const box of this.movingBoxes) {
            const angle = box.phase + timeSeconds * box.orbitSpeed;
            box.mesh.position.set(Math.sin(angle) * box.orbitRadius, 0.8 + 0.5 * Math.sin(angle * 2.0), 18 + Math.cos(angle) * box.orbitRadius);
            box.mesh.rotation.y = angle * 1.5;
        }
    }

    setGeometryVisible(visible) {
        this.sceneGeometryEnabled = visible;
        this.groundMesh.setEnabled(visible);
        this.pillarMesh.setEnabled(visible);
        for (const box of this.movingBoxes) {
            box.mesh.setEnabled(visible);
        }
    }

    update(timeSeconds, frameIndex) {
        for (const box of this.movingBoxes) {
            box.previousWorldMatrix.copyFrom(box.mesh.getWorldMatrix());
        }
        if (this.boxesFollowTime) {
            this.placeMovingBoxes(timeSeconds);
        }
        for (const box of this.movingBoxes) {
            box.mesh.computeWorldMatrix(true);
        }
        this.timeSeconds = timeSeconds;
        this.frameIndex = frameIndex;
    }

    dispatchCompute() {
        if (!this.patternEnabled) {
            return;
        }
        this.patternParameters.updateFloat("timeSeconds", this.timeSeconds);
        this.patternParameters.updateFloat("frameIndex", this.frameIndex);
        this.patternParameters.updateFloat("heavyIterations", this.heavyPatternIterations);
        this.patternParameters.updateFloat("solidColourMode", this.solidColourMode);
        this.patternParameters.update();
        this.profiler.explicitLabel = "testPattern";
        this.patternCompute.dispatch(patternTextureSize / 8, patternTextureSize / 8, 1);
        this.profiler.explicitLabel = null;
    }
}
