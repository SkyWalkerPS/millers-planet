import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Matrix, Vector4 } from "@babylonjs/core/Maths/math.vector";
import { buildLanderStates, composeTransforms, flattenLanderState, landerProxyBoxes, rotationTranslation } from "./landerGeometry.js";

export const SHIP_STATE_INTACT = 0;
export const SHIP_STATE_GONE = 4;
export const shipStateNames = ["intact", "70% intact", "40% intact", "wreckage", "gone"];
const damageByState = [0, 0.35, 0.65, 0.9, 0];

export const relocationSettings = {
    minimumDistanceMetres: 100,
    maximumDistanceMetres: 150,
    halfSpreadRadians: (40 * Math.PI) / 180,
};

function seededFractions(seed, count) {
    let state = (seed * 2654435761) >>> 0 || 1;
    const values = [];
    for (let index = 0; index < count; index++) {
        state ^= state << 13;
        state >>>= 0;
        state ^= state >>> 17;
        state ^= state << 5;
        state >>>= 0;
        values.push(state / 4294967296);
    }
    return values;
}

export function relocationForWave(waveIndex, impactX, impactZ, travelDirectionX, travelDirectionZ) {
    const [angleFraction, distanceFraction, yawFraction] = seededFractions(9173 + waveIndex * 101, 3);
    const travelAngle = Math.atan2(travelDirectionX, travelDirectionZ);
    const angle = travelAngle + (angleFraction * 2 - 1) * relocationSettings.halfSpreadRadians;
    const distance = relocationSettings.minimumDistanceMetres + (relocationSettings.maximumDistanceMetres - relocationSettings.minimumDistanceMetres) * distanceFraction;
    return {
        x: impactX + Math.sin(angle) * distance,
        z: impactZ + Math.cos(angle) * distance,
        yawRadians: yawFraction * Math.PI * 2,
        state: Math.min(waveIndex, SHIP_STATE_GONE),
        distanceMetres: distance,
        bearingFromTravelRadians: angle - travelAngle,
    };
}

export class Lander {
    constructor({ scene, frameUniforms, atmosphere, sceneProxies, waterLevelMetres = 0 }) {
        this.sceneProxies = sceneProxies;
        this.waterLevelMetres = waterLevelMetres;
        this.ride = null;
        this.states = buildLanderStates();
        this.localBoxes = this.states.map((state) => landerProxyBoxes(state));
        this.material = new ShaderMaterial("lander", scene, { vertex: "lander", fragment: "lander" }, {
            attributes: ["position", "normal", "uv", "landerAux"],
            uniforms: ["world", "previousWorld", "damageAndWaterLevel"],
            shaderLanguage: ShaderLanguage.WGSL,
        });
        this.material.setUniformBuffer("frame", frameUniforms.buffer);
        this.material.setUniformBuffer("sceneProxies", sceneProxies.buffer);
        atmosphere.bindSkyResources(this.material);
        this.material.backFaceCulling = false;
        this.meshes = this.states.map((state, index) => {
            if (!state.pieces.length) {
                return null;
            }
            const flat = flattenLanderState(state);
            const mesh = new Mesh(`lander-${index}`, scene);
            const vertexData = new VertexData();
            vertexData.positions = flat.positions;
            vertexData.normals = flat.normals;
            vertexData.uvs = flat.surfaceCoordinates;
            vertexData.indices = flat.indices;
            vertexData.applyToMesh(mesh, false);
            const aux = new Float32Array((flat.positions.length / 3) * 2);
            for (let vertex = 0; vertex < flat.positions.length / 3; vertex++) {
                aux[vertex * 2] = flat.slots[vertex];
            }
            mesh.setVerticesData("landerAux", aux, false, 2);
            mesh.material = this.material;
            mesh.alwaysSelectAsActiveMesh = true;
            mesh.isPickable = false;
            mesh.doNotSyncBoundingInfo = true;
            mesh.renderingGroupId = 0;
            mesh.setEnabled(false);
            return mesh;
        });
        this.triangleCounts = this.states.map((state) => flattenLanderState(state).triangleCount);
        this.worldMatrix = new Matrix();
        this.state = SHIP_STATE_INTACT;
        this.positionX = 0;
        this.positionZ = 0;
        this.yawRadians = 0;
        this.visible = true;
        this.worldBoxes = [];
        this.worldTransform = rotationTranslation(0, 0, 0, 0, 0, 0);
        this.placementCount = 0;
    }

    get meshesForWarmUp() {
        return this.meshes.filter(Boolean);
    }

    place(x, z, yawRadians, state = this.state) {
        this.positionX = x;
        this.positionZ = z;
        this.yawRadians = yawRadians;
        this.state = state;
        this.placementCount++;
        this.applyPlacement();
    }

    shiftOrigin(deltaX, deltaZ) {
        this.positionX -= deltaX;
        this.positionZ -= deltaZ;
        if (this.ride) {
            this.ride.x -= deltaX;
            this.ride.z -= deltaZ;
        }
        this.applyPlacement();
    }

    setRidePose(x, z, yawRadians, liftMetres, pitchRadians, rollRadians) {
        this.ride = { x, z, yawRadians, liftMetres, pitchRadians, rollRadians };
        this.applyPlacement();
    }

    clearRide() {
        if (this.ride) {
            this.ride = null;
            this.applyPlacement();
        }
    }

    get riding() {
        return Boolean(this.ride);
    }

    applyPlacement() {
        const state = this.state;
        const definition = this.states[state];
        const tilt = definition.tilt ?? { pitchRadians: 0, rollRadians: 0 };
        const ride = this.ride;
        const transform = ride
            ? composeTransforms(
                rotationTranslation(ride.yawRadians, 0, 0, ride.x, this.waterLevelMetres + definition.restingHeightMetres + ride.liftMetres, ride.z),
                rotationTranslation(0, tilt.pitchRadians + ride.pitchRadians, tilt.rollRadians + ride.rollRadians, 0, 0, 0),
            )
            : composeTransforms(
                rotationTranslation(this.yawRadians, 0, 0, this.positionX, this.waterLevelMetres + definition.restingHeightMetres, this.positionZ),
                rotationTranslation(0, tilt.pitchRadians, tilt.rollRadians, 0, 0, 0),
            );
        this.worldTransform = transform;
        Matrix.FromValuesToRef(
            transform[0], transform[1], transform[2], 0,
            transform[3], transform[4], transform[5], 0,
            transform[6], transform[7], transform[8], 0,
            transform[9], transform[10], transform[11], 1,
            this.worldMatrix,
        );
        this.material.setMatrix("world", this.worldMatrix);
        this.material.setMatrix("previousWorld", this.worldMatrix);
        this.material.setVector4("damageAndWaterLevel", new Vector4(damageByState[state], this.waterLevelMetres, 0, 0));
        this.worldBoxes = this.localBoxes[state].map((box) => ({
            name: box.name,
            showsThroughWater: box.showsThroughWater,
            poleLike: box.poleLike,
            centre: [
                transform[0] * box.centre[0] + transform[3] * box.centre[1] + transform[6] * box.centre[2] + transform[9],
                transform[1] * box.centre[0] + transform[4] * box.centre[1] + transform[7] * box.centre[2] + transform[10],
                transform[2] * box.centre[0] + transform[5] * box.centre[1] + transform[8] * box.centre[2] + transform[11],
            ],
            halfSize: box.halfSize.slice(),
            axes: box.axes.map((axis) => [
                transform[0] * axis[0] + transform[3] * axis[1] + transform[6] * axis[2],
                transform[1] * axis[0] + transform[4] * axis[1] + transform[7] * axis[2],
                transform[2] * axis[0] + transform[5] * axis[1] + transform[8] * axis[2],
            ]),
        }));
        this.applyVisibility();
    }

    setVisible(visible) {
        this.visible = visible;
        this.applyVisibility();
    }

    applyVisibility() {
        this.meshes.forEach((mesh, index) => {
            if (mesh) {
                mesh.setEnabled(this.visible && index === this.state);
            }
        });
        this.sceneProxies.setShipBoxes(this.visible && this.state !== SHIP_STATE_GONE ? this.worldBoxes : []);
    }

    distanceTo(x, z) {
        return Math.hypot(this.positionX - x, this.positionZ - z);
    }
}
