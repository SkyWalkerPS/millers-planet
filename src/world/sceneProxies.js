import { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";

export const maximumShipProxyBoxes = 16;

function boundingSphere(minimum, maximum) {
    if (!(maximum[0] >= minimum[0])) {
        return [0, 0, 0, 0];
    }
    const centre = [0, 1, 2].map((axis) => (minimum[axis] + maximum[axis]) / 2);
    return [centre[0], centre[1], centre[2], Math.hypot(maximum[0] - minimum[0], maximum[1] - minimum[1], maximum[2] - minimum[2]) / 2];
}

export class SceneProxies {
    constructor(engine) {
        this.buffer = new UniformBuffer(engine, undefined, false, "sceneProxies");
        this.buffer.addUniform("astronautBoundsAndEnabled", 4);
        this.buffer.addUniform("astronautCapsules", 4, 24);
        this.buffer.addUniform("shipBounds", 4);
        this.buffer.addUniform("shipBoxCount", 4);
        this.buffer.addUniform("shipBoxes", 4, maximumShipProxyBoxes * 4);
        this.buffer.addUniform("shipSubmergedBounds", 4);
        this.buffer.create();
        this.astronautCapsuleData = new Float32Array(96);
        this.astronautBounds = new Float32Array(4);
        this.shipBoxData = new Float32Array(maximumShipProxyBoxes * 16);
        this.shipBounds = new Float32Array(4);
        this.shipSubmergedBounds = new Float32Array(4);
        this.shipBoxes = [];
    }

    setShipBoxes(boxes) {
        this.shipBoxes = boxes.slice(0, maximumShipProxyBoxes);
        this.shipBoxData.fill(0);
        const minimum = [Infinity, Infinity, Infinity];
        const maximum = [-Infinity, -Infinity, -Infinity];
        const submergedMinimum = [Infinity, Infinity, Infinity];
        const submergedMaximum = [-Infinity, -Infinity, -Infinity];
        this.shipBoxes.forEach((box, index) => {
            const offset = index * 16;
            this.shipBoxData.set([box.centre[0], box.centre[1], box.centre[2], box.showsThroughWater ? 1 : 0], offset);
            for (let axis = 0; axis < 3; axis++) {
                this.shipBoxData.set([box.axes[axis][0], box.axes[axis][1], box.axes[axis][2], box.halfSize[axis]], offset + 4 + axis * 4);
                const reach = Math.abs(box.axes[0][axis]) * box.halfSize[0] + Math.abs(box.axes[1][axis]) * box.halfSize[1] + Math.abs(box.axes[2][axis]) * box.halfSize[2];
                minimum[axis] = Math.min(minimum[axis], box.centre[axis] - reach);
                maximum[axis] = Math.max(maximum[axis], box.centre[axis] + reach);
                if (box.showsThroughWater) {
                    submergedMinimum[axis] = Math.min(submergedMinimum[axis], box.centre[axis] - reach);
                    submergedMaximum[axis] = Math.max(submergedMaximum[axis], box.centre[axis] + reach);
                }
            }
        });
        this.shipBounds.set(boundingSphere(minimum, maximum));
        this.shipSubmergedBounds.set(boundingSphere(submergedMinimum, submergedMaximum));
    }

    write() {
        const buffer = this.buffer;
        buffer.updateFloat4("astronautBoundsAndEnabled", this.astronautBounds[0], this.astronautBounds[1], this.astronautBounds[2], this.astronautBounds[3]);
        buffer.updateFloatArray("astronautCapsules", this.astronautCapsuleData);
        buffer.updateFloat4("shipBounds", this.shipBounds[0], this.shipBounds[1], this.shipBounds[2], this.shipBounds[3]);
        buffer.updateFloat4("shipBoxCount", this.shipBoxes.length, 0, 0, 0);
        buffer.updateFloatArray("shipBoxes", this.shipBoxData);
        buffer.updateFloat4("shipSubmergedBounds", this.shipSubmergedBounds[0], this.shipSubmergedBounds[1], this.shipSubmergedBounds[2], this.shipSubmergedBounds[3]);
        buffer.update();
    }
}
