export const scriptedWalk = [
    { untilSeconds: 2, moveRight: 0, moveForward: 0, shift: false, label: "idle" },
    { untilSeconds: 8, moveRight: 0, moveForward: 1, shift: false, label: "walk forward" },
    { untilSeconds: 9, turnFromYaw: 0, turnToYaw: Math.PI / 2, shift: false, label: "90 degree turn while walking" },
    { untilSeconds: 12, moveRight: 1, moveForward: 0, shift: false, label: "walk after the turn" },
    { untilSeconds: 14, moveRight: 1, moveForward: 0, shift: true, label: "Shift walk" },
    { untilSeconds: 16.5, moveRight: 0, moveForward: 0, shift: false, label: "stop" },
    { untilSeconds: 19.5, moveRight: -0.4, moveForward: 0, shift: false, label: "turn in place 180 degrees" },
    { untilSeconds: 21.5, moveRight: 0, moveForward: 0, shift: false, label: "idle after turning" },
    { untilSeconds: 25, moveRight: 0, moveForward: -1, shift: false, label: "walk back toward the camera" },
    { untilSeconds: 27, moveRight: 0, moveForward: 0, shift: false, label: "final stop" },
];

export function scriptedInputAt(script, seconds) {
    let segmentStart = 0;
    for (const segment of script) {
        if (seconds < segment.untilSeconds) {
            if (segment.turnToYaw !== undefined) {
                const fraction = (seconds - segmentStart) / (segment.untilSeconds - segmentStart);
                const yaw = segment.turnFromYaw + (segment.turnToYaw - segment.turnFromYaw) * fraction;
                return { moveRight: Math.sin(yaw), moveForward: Math.cos(yaw), shift: segment.shift, label: segment.label };
            }
            return segment;
        }
        segmentStart = segment.untilSeconds;
    }
    return script[script.length - 1];
}
