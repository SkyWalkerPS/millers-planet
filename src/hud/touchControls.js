export const joystickRadiusPixels = 56;
export const runBeyondJoystickRadiusFraction = 1.45;

const glassBackground = "rgba(24, 24, 26, 0.26)";
const glassBorder = "1px solid rgba(255, 255, 255, 0.14)";
const glassBlur = "blur(14px) saturate(1.15)";

export function deviceHasTouch() {
    return (typeof navigator !== "undefined" && navigator.maxTouchPoints > 0) || (typeof matchMedia === "function" && matchMedia("(any-pointer: coarse)").matches);
}

function circle(sizePixels) {
    const element = document.createElement("div");
    Object.assign(element.style, {
        position: "fixed",
        left: "0",
        top: "0",
        width: `${sizePixels}px`,
        height: `${sizePixels}px`,
        marginLeft: `${-sizePixels / 2}px`,
        marginTop: `${-sizePixels / 2}px`,
        borderRadius: "50%",
        pointerEvents: "none",
        userSelect: "none",
        display: "none",
    });
    return element;
}

export class TouchControls {
    constructor(parent, { onViewButton }) {
        this.base = circle(joystickRadiusPixels * 2);
        this.base.id = "touch-joystick";
        Object.assign(this.base.style, {
            background: glassBackground,
            border: glassBorder,
            boxShadow: "0 1px 10px rgba(0, 0, 0, 0.12)",
            backdropFilter: glassBlur,
            webkitBackdropFilter: glassBlur,
        });
        this.knob = circle(48);
        this.knob.id = "touch-joystick-knob";
        Object.assign(this.knob.style, {
            background: "rgba(239, 236, 230, 0.55)",
            border: "1px solid rgba(255, 255, 255, 0.35)",
            boxShadow: "0 1px 8px rgba(0, 0, 0, 0.18)",
        });
        this.hint = document.createElement("div");
        this.hint.id = "touch-hint";
        this.hint.textContent = "Left: walk · Right: look";
        Object.assign(this.hint.style, {
            position: "fixed",
            left: "50%",
            bottom: "max(18px, env(safe-area-inset-bottom))",
            transform: "translateX(-50%)",
            padding: "8px 14px",
            borderRadius: "10px",
            background: glassBackground,
            border: glassBorder,
            backdropFilter: glassBlur,
            webkitBackdropFilter: glassBlur,
            color: "#efece6",
            font: "500 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
            whiteSpace: "nowrap",
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
            bottom: "max(16px, env(safe-area-inset-bottom))",
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
        parent.append(this.base, this.knob, this.hint, this.viewButton);
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

    showJoystick(originX, originY, knobX, knobY, running) {
        this.base.style.display = "block";
        this.knob.style.display = "block";
        this.base.style.transform = `translate(${originX}px, ${originY}px)`;
        this.knob.style.transform = `translate(${knobX}px, ${knobY}px)`;
        this.base.style.borderColor = running ? "rgba(255, 255, 255, 0.55)" : "rgba(255, 255, 255, 0.14)";
    }

    hideJoystick() {
        this.base.style.display = "none";
        this.knob.style.display = "none";
    }
}
