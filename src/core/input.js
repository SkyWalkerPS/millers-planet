import { TouchControls, joystickRadiusPixels, runBeyondJoystickRadiusFraction } from "../hud/touchControls.js";

const joystickBaseFollowsBeyondFraction = 2.2;
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
        this.touchMove = { pointerId: null, originX: 0, originY: 0, moveRight: 0, moveForward: 0, run: false };
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
        this.audioSystem.startOnUserGesture();
        this.touchControls?.dismissHint();
        const onLeftHalf = event.clientX < window.innerWidth * 0.5;
        if (onLeftHalf && this.touchMove.pointerId === null) {
            const move = this.touchMove;
            move.pointerId = event.pointerId;
            move.originX = event.clientX;
            move.originY = event.clientY;
            this.updateTouchMove(event.clientX, event.clientY);
        } else if (this.touchLook.pointerId === null) {
            this.touchLook.pointerId = event.pointerId;
            this.touchLook.lastX = event.clientX;
            this.touchLook.lastY = event.clientY;
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
        this.audioSystem.startOnUserGesture();
        if (event.pointerId === this.touchMove.pointerId) {
            this.releaseTouchMove();
        } else if (event.pointerId === this.touchLook.pointerId) {
            this.touchLook.pointerId = null;
        }
    }

    updateTouchMove(thumbX, thumbY) {
        const move = this.touchMove;
        let offsetX = thumbX - move.originX;
        let offsetY = thumbY - move.originY;
        const followDistance = joystickRadiusPixels * joystickBaseFollowsBeyondFraction;
        const thumbDistance = Math.hypot(offsetX, offsetY);
        if (thumbDistance > followDistance) {
            const pullFraction = (thumbDistance - followDistance) / thumbDistance;
            move.originX += offsetX * pullFraction;
            move.originY += offsetY * pullFraction;
            offsetX = thumbX - move.originX;
            offsetY = thumbY - move.originY;
        }
        const reach = Math.hypot(offsetX, offsetY) / joystickRadiusPixels;
        const deflection = Math.min(1, reach);
        const directionScale = reach > 0 ? deflection / reach : 0;
        move.moveRight = (offsetX / joystickRadiusPixels) * directionScale;
        move.moveForward = (-offsetY / joystickRadiusPixels) * directionScale;
        move.run = reach > runBeyondJoystickRadiusFraction;
        const knobX = move.originX + move.moveRight * joystickRadiusPixels;
        const knobY = move.originY - move.moveForward * joystickRadiusPixels;
        this.touchControls?.showJoystick(move.originX, move.originY, knobX, knobY, move.run);
    }

    releaseTouchMove() {
        const move = this.touchMove;
        move.pointerId = null;
        move.moveRight = 0;
        move.moveForward = 0;
        move.run = false;
        this.touchControls?.hideJoystick();
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
