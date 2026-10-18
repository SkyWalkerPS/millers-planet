import { openingYawRadians } from "../world/skyLayout.js";

const degreesToRadians = Math.PI / 180;

function orbitPose(targetX, targetY, targetZ, yawDegrees, pitchDegrees, distance) {
    const yaw = yawDegrees * degreesToRadians;
    const pitch = pitchDegrees * degreesToRadians;
    const cosinePitch = Math.cos(pitch);
    const forwardX = Math.sin(yaw) * cosinePitch;
    const forwardY = Math.sin(pitch);
    const forwardZ = Math.cos(yaw) * cosinePitch;
    return {
        position: [targetX - forwardX * distance, targetY - forwardY * distance, targetZ - forwardZ * distance],
        yawRadians: yaw,
        pitchRadians: pitch,
    };
}

export const shotDefinitions = {
    empty: {
        phase: 2,
        timeSeconds: 10,
        verticalFieldOfViewDegrees: 56,
        pose: () => ({ position: [0, 1.7, -20], yawRadians: openingYawRadians, pitchRadians: 2.7 * degreesToRadians }),
    },
    "debug-orbit-a": {
        phase: 2,
        timeSeconds: 10,
        verticalFieldOfViewDegrees: 56,
        pose: () => orbitPose(0, 1, 18, 35, -12, 28),
    },
    "debug-orbit-b": {
        phase: 2,
        timeSeconds: 10,
        verticalFieldOfViewDegrees: 56,
        pose: () => orbitPose(0, 1, 18, 160, -30, 14),
    },
    "spike-ground": {
        phase: 2,
        timeSeconds: 10,
        verticalFieldOfViewDegrees: 56,
        pose: () => ({ position: [0, 4, 5], yawRadians: 0, pitchRadians: -60 * degreesToRadians }),
    },
};

export function orbitCameraPose({ yawDegrees = 0, pitchDegrees = -10, distance = 20, targetHeight = 1, targetX = 0, targetZ = 18 } = {}) {
    return orbitPose(targetX, targetHeight, targetZ, yawDegrees, pitchDegrees, distance);
}
