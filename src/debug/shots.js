import { gargantuaAzimuthRadians, gargantuaElevationRadians, openingYawRadians } from "../world/skyLayout.js";

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
        hiddenSystems: ["sea"],
        timeSeconds: 10,
        verticalFieldOfViewDegrees: 56,
        pose: () => ({ position: [0, 1.7, -20], yawRadians: openingYawRadians, pitchRadians: 2.7 * degreesToRadians }),
    },
    "debug-orbit-a": {
        phase: 2,
        hiddenSystems: ["sea"],
        timeSeconds: 10,
        verticalFieldOfViewDegrees: 56,
        pose: () => orbitPose(0, 1, 18, 35, -12, 28),
    },
    "debug-orbit-b": {
        phase: 2,
        hiddenSystems: ["sea"],
        timeSeconds: 10,
        verticalFieldOfViewDegrees: 56,
        pose: () => orbitPose(0, 1, 18, 160, -30, 14),
    },
    "sky-gargantua": {
        phase: 3,
        hiddenSystems: ["testGeometry"],
        timeSeconds: 10,
        verticalFieldOfViewDegrees: 56,
        pose: () => ({ position: [0, 1.7, 0], yawRadians: gargantuaAzimuthRadians, pitchRadians: 10 * degreesToRadians }),
    },
    "sky-gargantua-tele": {
        phase: 3,
        hiddenSystems: ["testGeometry"],
        timeSeconds: 10,
        verticalFieldOfViewDegrees: 20,
        pose: () => ({ position: [0, 1.7, 0], yawRadians: gargantuaAzimuthRadians, pitchRadians: gargantuaElevationRadians }),
    },
    "sky-away": {
        phase: 3,
        hiddenSystems: ["testGeometry"],
        timeSeconds: 10,
        verticalFieldOfViewDegrees: 56,
        pose: () => ({ position: [0, 1.7, 0], yawRadians: gargantuaAzimuthRadians + Math.PI, pitchRadians: 8 * degreesToRadians }),
    },
    "sky-zenith": {
        phase: 3,
        hiddenSystems: ["testGeometry"],
        timeSeconds: 10,
        verticalFieldOfViewDegrees: 56,
        pose: () => ({ position: [0, 1.7, 0], yawRadians: gargantuaAzimuthRadians + 0.6, pitchRadians: 60 * degreesToRadians }),
    },
    "sea-wide": {
        phase: 4,
        hiddenSystems: ["testGeometry"],
        timeSeconds: 10,
        verticalFieldOfViewDegrees: 56,
        pose: () => ({ position: [0, 1.7, 0], yawRadians: gargantuaAzimuthRadians, pitchRadians: 0 }),
    },
    "sea-away": {
        phase: 4,
        hiddenSystems: ["testGeometry"],
        timeSeconds: 10,
        verticalFieldOfViewDegrees: 56,
        pose: () => ({ position: [0, 1.7, 0], yawRadians: gargantuaAzimuthRadians + Math.PI, pitchRadians: -4 * degreesToRadians }),
    },
    "sea-close": {
        phase: 4,
        hiddenSystems: ["testGeometry"],
        depthOfField: false,
        timeSeconds: 10,
        verticalFieldOfViewDegrees: 56,
        pose: () => ({ position: [0, 0.8, 0], yawRadians: gargantuaAzimuthRadians + 0.5, pitchRadians: -50 * degreesToRadians }),
    },
    "sea-ripples": {
        phase: 4,
        hiddenSystems: ["testGeometry"],
        depthOfField: false,
        timeSeconds: 10,
        verticalFieldOfViewDegrees: 56,
        ripplePrerollSteps: 32,
        rippleStamps: [
            { x: 0.0, z: 2.2, radius: 0.1, elongation: 1.7, forwardX: 0, forwardZ: 1, heightChange: 0.015, foam: 0.25, ringWeight: 0.48 },
            { x: 0.5, z: 3.0, radius: 0.1, elongation: 1.7, forwardX: 0, forwardZ: 1, heightChange: 0.015, foam: 0.25, ringWeight: 0.48, afterSteps: 16 },
            { x: -0.6, z: 1.6, radius: 0.09, elongation: 1.0, forwardX: 1, forwardZ: 0, heightChange: 0.01, foam: 0.15, ringWeight: 0.48, afterSteps: 24 },
        ],
        pose: () => ({ position: [0, 1.2, 0], yawRadians: 0, pitchRadians: -38 * degreesToRadians }),
    },
    "wave-reserve": {
        phase: 4,
        hiddenSystems: ["testGeometry"],
        shownSystems: ["waveReservation"],
        timeSeconds: 10,
        verticalFieldOfViewDegrees: 56,
        pose: () => ({ position: [0, 1.7, 0], yawRadians: gargantuaAzimuthRadians, pitchRadians: 2.7 * degreesToRadians }),
    },
    "spike-ground": {
        phase: 2,
        hiddenSystems: ["sea"],
        timeSeconds: 10,
        verticalFieldOfViewDegrees: 56,
        pose: () => ({ position: [0, 4, 5], yawRadians: 0, pitchRadians: -60 * degreesToRadians }),
    },
};

export function orbitCameraPose({ yawDegrees = 0, pitchDegrees = -10, distance = 20, targetHeight = 1, targetX = 0, targetZ = 18 } = {}) {
    return orbitPose(targetX, targetHeight, targetZ, yawDegrees, pitchDegrees, distance);
}
