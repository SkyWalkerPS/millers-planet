import { gargantuaAzimuthRadians, gargantuaElevationRadians, openingYawRadians } from "../world/skyLayout.js";
import { BONE_HELMET } from "../character/suitSkeleton.js";

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

function visorFrontCameraPose(figure, controller) {
    const world = figure.world;
    const helmetX = world[BONE_HELMET * 16 + 12];
    const helmetY = world[BONE_HELMET * 16 + 13];
    const helmetZ = world[BONE_HELMET * 16 + 14];
    const facing = controller.facingYaw;
    const forwardX = Math.sin(facing);
    const forwardZ = Math.cos(facing);
    const rightX = Math.cos(facing);
    const rightZ = -Math.sin(facing);
    const cameraX = helmetX + forwardX * 1.05 + rightX * 0.16;
    const cameraY = helmetY - 0.14;
    const cameraZ = helmetZ + forwardZ * 1.05 + rightZ * 0.16;
    const towardX = helmetX - cameraX;
    const towardY = helmetY - cameraY;
    const towardZ = helmetZ - cameraZ;
    return {
        position: [cameraX, cameraY, cameraZ],
        yawRadians: Math.atan2(towardX, towardZ),
        pitchRadians: Math.atan2(towardY, Math.hypot(towardX, towardZ)),
        verticalFieldOfViewDegrees: 30,
    };
}

function walkSplashCameraPose(figure, controller) {
    const facing = controller.facingYaw;
    const forwardX = Math.sin(facing);
    const forwardZ = Math.cos(facing);
    const rightX = Math.cos(facing);
    const rightZ = -Math.sin(facing);
    const targetX = controller.positionX + forwardX * 0.25;
    const targetY = 0.25;
    const targetZ = controller.positionZ + forwardZ * 0.25;
    const cameraX = controller.positionX + forwardX * 1.1 + rightX * 2.0;
    const cameraY = 0.85;
    const cameraZ = controller.positionZ + forwardZ * 1.1 + rightZ * 2.0;
    const towardX = targetX - cameraX;
    const towardY = targetY - cameraY;
    const towardZ = targetZ - cameraZ;
    return {
        position: [cameraX, cameraY, cameraZ],
        yawRadians: Math.atan2(towardX, towardZ),
        pitchRadians: Math.atan2(towardY, Math.hypot(towardX, towardZ)),
        verticalFieldOfViewDegrees: 50,
    };
}

function walkRipplesCameraPose(figure, controller) {
    const facing = controller.facingYaw;
    const forwardX = Math.sin(facing);
    const forwardZ = Math.cos(facing);
    const rightX = Math.cos(facing);
    const rightZ = -Math.sin(facing);
    const targetX = controller.positionX - forwardX * 0.55;
    const targetY = 0;
    const targetZ = controller.positionZ - forwardZ * 0.55;
    const cameraX = controller.positionX - forwardX * 1.9 + rightX * 1.7;
    const cameraY = 2.1;
    const cameraZ = controller.positionZ - forwardZ * 1.9 + rightZ * 1.7;
    const towardX = targetX - cameraX;
    const towardY = targetY - cameraY;
    const towardZ = targetZ - cameraZ;
    return {
        position: [cameraX, cameraY, cameraZ],
        yawRadians: Math.atan2(towardX, towardZ),
        pitchRadians: Math.atan2(towardY, Math.hypot(towardX, towardZ)),
        verticalFieldOfViewDegrees: 50,
    };
}

const shipViewYawRadians = gargantuaAzimuthRadians - 0.42;
const shipViewDistanceMetres = 26;

function shipStateShot(state) {
    return {
        phase: 6,
        hiddenSystems: ["testGeometry"],
        timeSeconds: 10,
        verticalFieldOfViewDegrees: 56,
        ship: { x: Math.sin(shipViewYawRadians) * shipViewDistanceMetres, z: Math.cos(shipViewYawRadians) * shipViewDistanceMetres, yawRadians: shipViewYawRadians + 1.95, state },
        pose: () => ({ position: [0, 1.7, 0], yawRadians: shipViewYawRadians, pitchRadians: 2.5 * degreesToRadians }),
    };
}


function waveApproachShot(timeSeconds, cameraPitchDegrees = null, playerOptions = {}) {
    return {
        phase: 7,
        hiddenSystems: ["testGeometry"],
        shownSystems: ["wave"],
        timeSeconds,
        verticalFieldOfViewDegrees: 56,
        ship: "opening",
        player: { preset: 0, x: 0, z: 0, yawRadians: openingYawRadians, cameraYawRadians: openingYawRadians, cameraPitchRadians: cameraPitchDegrees === null ? null : cameraPitchDegrees * degreesToRadians, ...playerOptions },
    };
}

function waveChoreographyShot(timeSeconds, cropAroundHelmet = null) {
    const shot = waveApproachShot(timeSeconds);
    shot.depthOfField = false;
    shot.player = { ...shot.player, waveChoreography: true };
    if (cropAroundHelmet) {
        shot.player.cropAroundHelmet = cropAroundHelmet;
    }
    return shot;
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
    "astro-third": {
        phase: 5,
        hiddenSystems: ["testGeometry"],
        timeSeconds: 10,
        verticalFieldOfViewDegrees: 56,
        player: { preset: 0, x: 0, z: 0, yawRadians: openingYawRadians, cameraYawRadians: openingYawRadians },
    },
    "astro-close": {
        phase: 5,
        hiddenSystems: ["testGeometry"],
        timeSeconds: 10,
        verticalFieldOfViewDegrees: 50,
        player: { preset: 1, x: 0, z: 0, yawRadians: openingYawRadians, cameraYawRadians: openingYawRadians },
    },
    "astro-first": {
        phase: 5,
        hiddenSystems: ["testGeometry"],
        timeSeconds: 10,
        verticalFieldOfViewDegrees: 62,
        player: { preset: 2, x: 0, z: 0, yawRadians: openingYawRadians, cameraYawRadians: openingYawRadians, cameraPitchRadians: -12 * degreesToRadians },
    },
    "visor-front-gargantua": {
        phase: 5,
        hiddenSystems: ["testGeometry"],
        depthOfField: false,
        timeSeconds: 10,
        verticalFieldOfViewDegrees: 30,
        player: { preset: 0, x: 0, z: 0, yawRadians: gargantuaAzimuthRadians, cameraPose: visorFrontCameraPose, cropAroundHelmet: 0.2 },
    },
    "walk-ripples": {
        phase: 5,
        hiddenSystems: ["testGeometry"],
        depthOfField: false,
        timeSeconds: 10,
        verticalFieldOfViewDegrees: 50,
        player: { preset: 1, x: 0, z: 0, yawRadians: gargantuaAzimuthRadians + 1.1, cameraYawRadians: gargantuaAzimuthRadians + 1.1, walkSeconds: 3.3, moveForward: 1, cameraPose: walkRipplesCameraPose },
    },
    "walk-splash": {
        phase: 7,
        hiddenSystems: ["testGeometry"],
        depthOfField: false,
        timeSeconds: 10,
        verticalFieldOfViewDegrees: 50,
        player: { preset: 1, x: 0, z: 0, yawRadians: gargantuaAzimuthRadians + 1.1, cameraYawRadians: gargantuaAzimuthRadians + 1.1, walkSeconds: 2.75, moveForward: 1, shift: true, cameraPose: walkSplashCameraPose },
    },
    "ship-0": shipStateShot(0),
    "ship-1": shipStateShot(1),
    "ship-2": shipStateShot(2),
    "ship-3": shipStateShot(3),
    "ship-4": shipStateShot(4),
    "ship-0-silhouette": {
        phase: 6,
        hiddenSystems: ["testGeometry"],
        timeSeconds: 10,
        verticalFieldOfViewDegrees: 40,
        ship: { x: Math.sin(gargantuaAzimuthRadians) * 34, z: Math.cos(gargantuaAzimuthRadians) * 34, yawRadians: gargantuaAzimuthRadians + Math.PI / 2, state: 0 },
        pose: () => ({ position: [0, 0.9, 0], yawRadians: gargantuaAzimuthRadians, pitchRadians: 6 * degreesToRadians }),
    },
    hud: {
        phase: 6,
        hiddenSystems: ["testGeometry"],
        timeSeconds: 754,
        verticalFieldOfViewDegrees: 56,
        showHud: true,
        ship: "opening",
        player: { preset: 0, x: 0, z: 0, yawRadians: openingYawRadians, cameraYawRadians: openingYawRadians },
    },
    "wave-a-far": waveApproachShot(240),
    "wave-a-move": waveApproachShot(241),
    "wave-a-near": waveApproachShot(270),
    "crest-backlit": waveApproachShot(269, 6, { cropWaveCrestAndFace: true }),
    "wave-b-brace": waveChoreographyShot(295),
    "visor-front-wave": waveChoreographyShot(298, 0.32),
    "wave-c-underwater": waveChoreographyShot(302),
    "wave-d-drain": waveChoreographyShot(308),
    "wave-after": waveChoreographyShot(315),
    "wave-receding": waveApproachShot(330, 8, { cameraYawRadians: openingYawRadians + Math.PI }),
    "wave-receding-far": waveApproachShot(400, 4, { cameraYawRadians: openingYawRadians + Math.PI }),
    "camera-collide-ship": {
        phase: 6,
        hiddenSystems: ["testGeometry"],
        timeSeconds: 10,
        verticalFieldOfViewDegrees: 56,
        ship: { x: 0, z: 6.2, yawRadians: Math.PI / 2, state: 0 },
        player: { preset: 0, x: 0, z: 2.4, yawRadians: Math.PI, cameraYawRadians: Math.PI, cameraPitchRadians: 4 * degreesToRadians },
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
