const mutedPreferenceStorageKey = "millersPlanet.muted";
const svgNamespace = "http://www.w3.org/2000/svg";
const speakerPath = "M4 9.5h3.2L12 5.5v13l-4.8-4H4z";
const soundWavePaths = ["M15.2 9.2a4 4 0 0 1 0 5.6", "M17.6 6.8a7.4 7.4 0 0 1 0 10.4"];
const mutedCrossPaths = ["M15.5 9.5l5 5", "M20.5 9.5l-5 5"];

export function readStoredMutedPreference() {
    try {
        const stored = window.localStorage.getItem(mutedPreferenceStorageKey);
        return stored === null ? null : stored === "1";
    } catch {
        return null;
    }
}

function storeMutedPreference(muted) {
    try {
        window.localStorage.setItem(mutedPreferenceStorageKey, muted ? "1" : "0");
    } catch {
        return;
    }
}

function strokedPath(pathData) {
    const path = document.createElementNS(svgNamespace, "path");
    path.setAttribute("d", pathData);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.7");
    path.setAttribute("stroke-linecap", "round");
    return path;
}

export class MuteButton {
    constructor(parent, { muted, onChange }) {
        this.onChange = onChange;
        this.button = document.createElement("button");
        this.button.id = "mute-button";
        this.button.type = "button";
        Object.assign(this.button.style, {
            marginLeft: "auto",
            padding: "0 clamp(10px, 3vw, 16px)",
            borderRadius: "10px",
            background: "rgba(24, 24, 26, 0.26)",
            border: "1px solid rgba(255, 255, 255, 0.14)",
            boxShadow: "0 1px 10px rgba(0, 0, 0, 0.12)",
            backdropFilter: "blur(14px) saturate(1.15)",
            webkitBackdropFilter: "blur(14px) saturate(1.15)",
            color: "#efece6",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            pointerEvents: "auto",
            touchAction: "manipulation",
            userSelect: "none",
            webkitTapHighlightColor: "transparent",
        });
        const icon = document.createElementNS(svgNamespace, "svg");
        icon.setAttribute("viewBox", "0 0 24 24");
        icon.setAttribute("width", "22");
        icon.setAttribute("height", "22");
        icon.setAttribute("aria-hidden", "true");
        const speaker = document.createElementNS(svgNamespace, "path");
        speaker.setAttribute("d", speakerPath);
        speaker.setAttribute("fill", "currentColor");
        this.soundWaves = soundWavePaths.map(strokedPath);
        this.mutedCross = mutedCrossPaths.map(strokedPath);
        icon.append(speaker, ...this.soundWaves, ...this.mutedCross);
        this.button.appendChild(icon);
        this.button.addEventListener("pointerdown", (event) => event.stopPropagation());
        this.button.addEventListener("click", (event) => {
            event.stopPropagation();
            this.toggle();
        });
        parent.appendChild(this.button);
        this.showMuted(muted);
    }

    toggle() {
        this.showMuted(!this.muted);
        storeMutedPreference(this.muted);
        this.onChange(this.muted);
    }

    showMuted(muted) {
        this.muted = muted;
        for (const path of this.soundWaves) {
            path.style.display = muted ? "none" : "";
        }
        for (const path of this.mutedCross) {
            path.style.display = muted ? "" : "none";
        }
        this.button.setAttribute("aria-label", muted ? "Sound off. Turn sound on" : "Sound on. Mute");
        this.button.setAttribute("aria-pressed", muted ? "true" : "false");
        this.button.title = muted ? "Sound off (M)" : "Sound on (M)";
    }

    setVisible(visible) {
        this.button.style.display = visible ? "flex" : "none";
    }
}
