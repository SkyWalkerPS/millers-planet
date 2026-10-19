const largestJoystickRadiusPixels = 56;
const joystickDiameterCss = `clamp(84px, 26vmin, ${largestJoystickRadiusPixels * 2}px)`;
export const runBeyondJoystickRadiusFraction = 1.45;
const joystickTouchAreaRadiusFraction = 1.3;
const joystickLiftPixels = 22;

const glassBackground = "rgba(24, 24, 26, 0.26)";
const glassBorder = "1px solid rgba(255, 255, 255, 0.14)";
const glassBlur = "blur(14px) saturate(1.15)";
const safeBottom = "max(16px, env(safe-area-inset-bottom))";

export function deviceHasTouch() {
    return (typeof navigator !== "undefined" && navigator.maxTouchPoints > 0) || (typeof matchMedia === "function" && matchMedia("(any-pointer: coarse)").matches);
}

export class TouchControls {
    constructor(parent, { onViewButton }) {
        this.base = document.createElement("div");
        this.base.id = "touch-joystick";
        this.base.setAttribute("aria-label", "Walk: drag inside this circle");
        Object.assign(this.base.style, {
            position: "fixed",
            left: "50%",
            bottom: `calc(${safeBottom} + ${joystickLiftPixels}px)`,
            width: joystickDiameterCss,
            height: joystickDiameterCss,
            transform: "translateX(-50%)",
            borderRadius: "50%",
            background: "rgba(255, 255, 255, 0.05)",
            border: "1.5px solid rgba(255, 255, 255, 0.42)",
            boxShadow: "0 0 10px rgba(0, 0, 0, 0.10), inset 0 0 10px rgba(0, 0, 0, 0.06)",
            pointerEvents: "none",
            userSelect: "none",
            display: "none",
        });
        this.knob = document.createElement("div");
        this.knob.id = "touch-joystick-knob";
        Object.assign(this.knob.style, {
            position: "absolute",
            left: "29.5%",
            top: "29.5%",
            width: "41%",
            height: "41%",
            borderRadius: "50%",
            background: "rgba(239, 236, 230, 0.34)",
            border: "1px solid rgba(255, 255, 255, 0.5)",
            boxShadow: "0 1px 8px rgba(0, 0, 0, 0.18)",
            pointerEvents: "none",
        });
        this.base.appendChild(this.knob);
        this.hint = document.createElement("div");
        this.hint.id = "touch-hint";
        this.hint.textContent = "Drag the circle to walk\nDrag anywhere else to look";
        Object.assign(this.hint.style, {
            position: "fixed",
            left: "50%",
            bottom: `calc(${safeBottom} + ${joystickLiftPixels + 14}px + ${joystickDiameterCss})`,
            transform: "translateX(-50%)",
            padding: "8px 14px",
            borderRadius: "10px",
            background: glassBackground,
            border: glassBorder,
            backdropFilter: glassBlur,
            webkitBackdropFilter: glassBlur,
            color: "#efece6",
            font: "500 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
            whiteSpace: "pre",
            textAlign: "center",
            pointerEvents: "none",
            userSelect: "none",
            transition: "opacity 0.6s",
            display: "none",
        });
        this.viewButton = document.createElement("button");
        this.viewButton.id = "touch-view-button";
        this.viewButton.type = "button";
        this.viewButton.textContent = "View";
        this.viewButton.setAttribute("aria-label", "Change the camera view");
        Object.assign(this.viewButton.style, {
            position: "fixed",
            right: "max(16px, env(safe-area-inset-right))",
            bottom: safeBottom,
            padding: "9px 14px",
            borderRadius: "10px",
            background: glassBackground,
            border: glassBorder,
            boxShadow: "0 1px 10px rgba(0, 0, 0, 0.12)",
            backdropFilter: glassBlur,
            webkitBackdropFilter: glassBlur,
            color: "#efece6",
            font: "500 13px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
            touchAction: "manipulation",
            userSelect: "none",
            webkitTapHighlightColor: "transparent",
            display: "none",
        });
        this.viewButton.addEventListener("pointerdown", (event) => {
            event.stopPropagation();
            event.preventDefault();
            onViewButton();
        });
        parent.append(this.base, this.hint, this.viewButton);
        this.touchDevice = deviceHasTouch();
        this.hudVisible = true;
        this.hintDismissed = false;
        this.applyVisibility();
    }

    setHudVisible(visible) {
        this.hudVisible = visible;
        this.applyVisibility();
    }

    applyVisibility() {
        const shown = this.touchDevice && this.hudVisible;
        this.base.style.display = shown ? "block" : "none";
        this.viewButton.style.display = shown ? "block" : "none";
        this.hint.style.display = shown && !this.hintDismissed ? "block" : "none";
    }

    dismissHint() {
        if (this.hintDismissed) {
            return;
        }
        this.hintDismissed = true;
        this.hint.style.opacity = "0";
        setTimeout(() => this.applyVisibility(), 700);
    }

    joystickCircle() {
        const box = this.base.getBoundingClientRect();
        if (box.width === 0) {
            return null;
        }
        return { x: box.left + box.width / 2, y: box.top + box.height / 2, radius: box.width / 2 };
    }

    joystickCircleContaining(x, y) {
        const circle = this.joystickCircle();
        return circle !== null && Math.hypot(x - circle.x, y - circle.y) <= circle.radius * joystickTouchAreaRadiusFraction ? circle : null;
    }

    setKnobOffset(offsetX, offsetY, running) {
        this.knob.style.transform = `translate(${offsetX}px, ${offsetY}px)`;
        this.base.style.borderColor = running ? "rgba(255, 255, 255, 0.75)" : "rgba(255, 255, 255, 0.38)";
    }

    resetKnob() {
        this.setKnobOffset(0, 0, false);
    }
}
