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
        this.handlePointerDown = (event) => {
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
        canvas.addEventListener("pointerdown", this.handlePointerDown);
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
