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

export class ClockPanel {
    constructor(parent) {
        const panel = document.createElement("div");
        panel.id = "clocks";
        panel.setAttribute("aria-label", "Mission clocks");
        Object.assign(panel.style, {
            position: "fixed",
            left: "16px",
            top: "16px",
            padding: "10px 14px 11px",
            borderRadius: "10px",
            background: "rgba(24, 24, 26, 0.26)",
            border: "1px solid rgba(255, 255, 255, 0.14)",
            boxShadow: "0 1px 10px rgba(0, 0, 0, 0.12)",
            backdropFilter: "blur(14px) saturate(1.15)",
            webkitBackdropFilter: "blur(14px) saturate(1.15)",
            color: "#efece6",
            font: "500 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
            fontVariantNumeric: "tabular-nums",
            letterSpacing: "0.02em",
            pointerEvents: "none",
            userSelect: "none",
            display: "grid",
            gridTemplateColumns: "auto auto",
            columnGap: "14px",
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
        this.millerValue = addRow("Miller");
        this.earthValue = addRow("Earth");
        this.millerText = "";
        this.earthText = "";
        this.panel = panel;
        parent.appendChild(panel);
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
