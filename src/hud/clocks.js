export const earthSecondsPerMillerSecond = 7 * 365.25 * 24;
const secondsPerJulianYear = 365.25 * 86400;

function twoDigits(value) {
    return value < 10 ? `0${value}` : `${value}`;
}

export function formatMillerClock(millerSeconds) {
    const wholeSeconds = Math.max(0, Math.floor(millerSeconds));
    const hours = Math.floor(wholeSeconds / 3600);
    const minutes = Math.floor((wholeSeconds % 3600) / 60);
    const seconds = wholeSeconds % 60;
    return `${twoDigits(hours)}:${twoDigits(minutes)}:${twoDigits(seconds)}`;
}

export function formatEarthClock(millerSeconds) {
    const earthMinutes = Math.floor((Math.max(0, millerSeconds) * earthSecondsPerMillerSecond) / 60);
    const minutesPerJulianYear = secondsPerJulianYear / 60;
    const years = Math.floor(earthMinutes / minutesPerJulianYear);
    const minutesIntoYear = Math.round(earthMinutes - years * minutesPerJulianYear);
    const days = Math.floor(minutesIntoYear / 1440);
    const hours = Math.floor((minutesIntoYear % 1440) / 60);
    const minutes = minutesIntoYear % 60;
    return `${years} yr ${days} d ${twoDigits(hours)}:${twoDigits(minutes)}`;
}

export function formatImpactCountdown(secondsBeforeImpact) {
    if (secondsBeforeImpact <= 0) {
        return "now";
    }
    const wholeSeconds = Math.ceil(secondsBeforeImpact);
    return `${twoDigits(Math.floor(wholeSeconds / 60))}:${twoDigits(wholeSeconds % 60)}`;
}

export function createHudRow(parent) {
    const row = document.createElement("div");
    row.id = "hud";
    Object.assign(row.style, {
        position: "fixed",
        left: "max(clamp(10px, 3vw, 16px), env(safe-area-inset-left))",
        right: "max(clamp(10px, 3vw, 16px), env(safe-area-inset-right))",
        top: "max(clamp(10px, 3vw, 16px), env(safe-area-inset-top))",
        display: "flex",
        alignItems: "stretch",
        gap: "clamp(6px, 2vw, 10px)",
        pointerEvents: "none",
        userSelect: "none",
    });
    parent.appendChild(row);
    return row;
}

function createGlassPanel(parent, id, ariaLabel) {
    const panel = document.createElement("div");
    panel.id = id;
    panel.setAttribute("aria-label", ariaLabel);
    Object.assign(panel.style, {
        padding: "clamp(7px, 2vw, 10px) clamp(9px, 2.8vw, 14px) clamp(8px, 2.2vw, 11px)",
        borderRadius: "10px",
        background: "rgba(24, 24, 26, 0.26)",
        border: "1px solid rgba(255, 255, 255, 0.14)",
        boxShadow: "0 1px 10px rgba(0, 0, 0, 0.12)",
        backdropFilter: "blur(14px) saturate(1.15)",
        webkitBackdropFilter: "blur(14px) saturate(1.15)",
        color: "#efece6",
        font: "500 clamp(10px, 2.7vw, 13px)/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        fontVariantNumeric: "tabular-nums",
        letterSpacing: "0.02em",
        whiteSpace: "nowrap",
        pointerEvents: "none",
        userSelect: "none",
        display: "grid",
        gridTemplateColumns: "auto auto",
        columnGap: "clamp(8px, 2.6vw, 14px)",
        rowGap: "2px",
    });
    const addRow = (label) => {
        const name = document.createElement("span");
        name.textContent = label;
        name.style.opacity = "0.62";
        const value = document.createElement("span");
        panel.append(name, value);
        return value;
    };
    parent.appendChild(panel);
    return { panel, addRow };
}

export class ClockPanel {
    constructor(parent) {
        const { panel, addRow } = createGlassPanel(parent, "clocks", "Mission clocks");
        this.millerValue = addRow("Miller");
        this.earthValue = addRow("Earth");
        this.millerText = "";
        this.earthText = "";
        this.panel = panel;
    }

    update(millerSeconds) {
        const millerText = formatMillerClock(millerSeconds);
        const earthText = formatEarthClock(millerSeconds);
        if (millerText !== this.millerText) {
            this.millerText = millerText;
            this.millerValue.textContent = millerText;
        }
        if (earthText !== this.earthText) {
            this.earthText = earthText;
            this.earthValue.textContent = earthText;
        }
    }

    setVisible(visible) {
        this.panel.style.display = visible ? "grid" : "none";
    }
}

export class WaveCountdownPanel {
    constructor(parent) {
        const { panel, addRow } = createGlassPanel(parent, "wave-countdown", "Time to the next wave impact");
        this.waveValue = addRow("Wave");
        this.countdownValue = addRow("Impact in");
        this.waveText = "";
        this.countdownText = "";
        this.panel = panel;
    }

    update(waveIndex, secondsBeforeImpact) {
        const waveText = `${waveIndex}`;
        const countdownText = formatImpactCountdown(secondsBeforeImpact);
        if (waveText !== this.waveText) {
            this.waveText = waveText;
            this.waveValue.textContent = waveText;
        }
        if (countdownText !== this.countdownText) {
            this.countdownText = countdownText;
            this.countdownValue.textContent = countdownText;
        }
    }

    setVisible(visible) {
        this.panel.style.display = visible ? "grid" : "none";
    }
}
