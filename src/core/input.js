import { TouchControls, runBeyondJoystickRadiusFraction } from "../hud/touchControls.js";

const touchLookCountsPerPixel = 4;

export class InputState {
    constructor(canvas, audioSystem) {
        this.canvas = canvas;
        this.audioSystem = audioSystem;
        this.heldKeyCodes = new Set();
        this.pendingMouseDeltaX = 0;
        this.pendingMouseDeltaY = 0;
        this.pointerLocked = false;
        this.wheelEventsSeen = 0;
        this.wheelEventsPrevented = 0;
        this.pressedKeyQueue = [];
        this.audioStartError = null;
        this.touchMove = { pointerId: null, originX: 0, originY: 0, radius: 1, moveRight: 0, moveForward: 0, run: false };
        this.touchLook = { pointerId: null, lastX: 0, lastY: 0 };
        this.touchControls = typeof document === "undefined" ? null : new TouchControls(document.body, { onViewButton: () => this.pressedKeyQueue.push("KeyC") });
        this.handlePointerDown = (event) => {
            if (event.pointerType !== "mouse") {
                this.beginTouch(event);
                return;
            }
            if (event.button !== 0) {
                return;
            }
            if (document.pointerLockElement !== canvas && canvas.requestPointerLock) {
                const lockRequest = canvas.requestPointerLock();
                if (lockRequest && lockRequest.catch) {
                    lockRequest.catch(() => {});
                }
            }
            this.audioSystem.startOnUserGesture();
        };
        this.handlePointerLockChange = () => {
            this.pointerLocked = document.pointerLockElement === canvas;
            if (!this.pointerLocked) {
                this.releaseEverything();
            }
        };
        this.handleKeyDown = (event) => {
            if (event.repeat) {
                return;
            }
            this.heldKeyCodes.add(event.code);
            this.pressedKeyQueue.push(event.code);
        };
        this.handleKeyUp = (event) => {
            this.heldKeyCodes.delete(event.code);
        };
        this.handleBlur = () => this.releaseEverything();
        this.handleMouseMove = (event) => {
            if (this.pointerLocked) {
                this.pendingMouseDeltaX += event.movementX;
                this.pendingMouseDeltaY += event.movementY;
            }
        };
        this.handleWheelOnWindow = (event) => {
            event.preventDefault();
            this.wheelEventsSeen++;
            if (event.defaultPrevented) {
                this.wheelEventsPrevented++;
            }
        };
        this.handleWheelOnCanvas = (event) => {
            event.preventDefault();
        };
        this.handleGesture = (event) => {
            event.preventDefault();
        };
        this.handlePointerMove = (event) => {
            if (event.pointerType !== "mouse") {
                this.moveTouch(event);
            }
        };
        this.handlePointerEnd = (event) => {
            if (event.pointerType !== "mouse") {
                this.endTouch(event);
            }
        };
        canvas.addEventListener("pointerdown", this.handlePointerDown);
        canvas.addEventListener("pointermove", this.handlePointerMove);
        canvas.addEventListener("pointerup", this.handlePointerEnd);
        canvas.addEventListener("pointercancel", this.handlePointerEnd);
        canvas.addEventListener("lostpointercapture", this.handlePointerEnd);
        window.addEventListener("pointerup", this.handlePointerEnd);
        window.addEventListener("pointercancel", this.handlePointerEnd);
        document.addEventListener("pointerlockchange", this.handlePointerLockChange);
        window.addEventListener("keydown", this.handleKeyDown);
        window.addEventListener("keyup", this.handleKeyUp);
        window.addEventListener("blur", this.handleBlur);
        document.addEventListener("mousemove", this.handleMouseMove);
        window.addEventListener("wheel", this.handleWheelOnWindow, { passive: false });
        canvas.addEventListener("wheel", this.handleWheelOnCanvas, { passive: false });
        window.addEventListener("gesturestart", this.handleGesture, { passive: false });
        window.addEventListener("gesturechange", this.handleGesture, { passive: false });
    }

    releaseEverything() {
        this.heldKeyCodes.clear();
        this.pendingMouseDeltaX = 0;
        this.pendingMouseDeltaY = 0;
        this.releaseTouchMove();
        this.touchLook.pointerId = null;
    }

    beginTouch(event) {
        event.preventDefault();
        const joystickCircle = this.touchControls?.joystickCircleContaining(event.clientX, event.clientY) ?? null;
        if (joystickCircle) {
            const move = this.touchMove;
            move.pointerId = event.pointerId;
            move.originX = joystickCircle.x;
            move.originY = joystickCircle.y;
            move.radius = joystickCircle.radius;
            this.updateTouchMove(event.clientX, event.clientY);
        } else {
            this.touchLook.pointerId = event.pointerId;
            this.touchLook.lastX = event.clientX;
            this.touchLook.lastY = event.clientY;
        }
        this.startAudioWithoutBreakingInput();
    }

    startAudioWithoutBreakingInput() {
        try {
            this.audioSystem.startOnUserGesture();
        } catch (error) {
            this.audioStartError = String(error);
        }
    }

    moveTouch(event) {
        if (event.pointerId === this.touchMove.pointerId) {
            event.preventDefault();
            this.updateTouchMove(event.clientX, event.clientY);
        } else if (event.pointerId === this.touchLook.pointerId) {
            event.preventDefault();
            const look = this.touchLook;
            this.pendingMouseDeltaX += (event.clientX - look.lastX) * touchLookCountsPerPixel;
            this.pendingMouseDeltaY += (event.clientY - look.lastY) * touchLookCountsPerPixel;
            look.lastX = event.clientX;
            look.lastY = event.clientY;
        }
    }

    endTouch(event) {
        if (event.pointerId === this.touchMove.pointerId) {
            this.releaseTouchMove();
        } else if (event.pointerId === this.touchLook.pointerId) {
            this.touchLook.pointerId = null;
        }
        if (event.type === "pointerup") {
            this.startAudioWithoutBreakingInput();
        }
    }

    updateTouchMove(thumbX, thumbY) {
        const move = this.touchMove;
        const offsetX = thumbX - move.originX;
        const offsetY = thumbY - move.originY;
        const reach = Math.hypot(offsetX, offsetY) / move.radius;
        const deflection = Math.min(1, reach);
        const directionScale = reach > 0 ? deflection / reach : 0;
        move.moveRight = (offsetX / move.radius) * directionScale;
        move.moveForward = (-offsetY / move.radius) * directionScale;
        move.run = reach > runBeyondJoystickRadiusFraction;
        if (reach > 0.3) {
            this.touchControls?.dismissHint();
        }
        this.touchControls?.setKnobOffset(move.moveRight * move.radius, -move.moveForward * move.radius, move.run);
    }

    releaseTouchMove() {
        const move = this.touchMove;
        move.pointerId = null;
        move.moveRight = 0;
        move.moveForward = 0;
        move.run = false;
        this.touchControls?.resetKnob();
    }

    isHeld(code) {
        return this.heldKeyCodes.has(code);
    }

    consumeMouseDelta(target) {
        target[0] = this.pendingMouseDeltaX;
        target[1] = this.pendingMouseDeltaY;
        this.pendingMouseDeltaX = 0;
        this.pendingMouseDeltaY = 0;
        return target;
    }

    takePressedKeys(target) {
        target.length = 0;
        for (let index = 0; index < this.pressedKeyQueue.length; index++) {
            target.push(this.pressedKeyQueue[index]);
        }
        this.pressedKeyQueue.length = 0;
        return target;
    }
}
