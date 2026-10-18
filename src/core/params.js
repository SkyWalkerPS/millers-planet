function readNumber(query, name) {
    const text = query.get(name);
    if (text === null || text.trim() === "") {
        return null;
    }
    const value = Number(text);
    return Number.isFinite(value) ? value : null;
}

export function readUrlParameters(search = window.location.search) {
    const query = new URLSearchParams(search);
    const disabledSystems = [];
    const enabledSystems = [];
    for (const token of (query.get("systems") ?? "").split(",")) {
        const trimmed = token.trim();
        if (trimmed === "") {
            continue;
        }
        if (trimmed.startsWith("-")) {
            disabledSystems.push(trimmed.slice(1));
        } else {
            enabledSystems.push(trimmed.replace(/^\+/, ""));
        }
    }
    let waveSkip = null;
    const waveText = query.get("wave");
    if (waveText) {
        const [waveIndexText, phaseText, secondsText] = waveText.split(",");
        waveSkip = { waveIndex: Number(waveIndexText) || 0, phase: phaseText || "approach", secondsIntoPhase: Number(secondsText) || 0 };
    }
    return {
        pinnedScale: readNumber(query, "scale"),
        frozenTimeSeconds: readNumber(query, "time"),
        shotName: query.get("shot"),
        viewPreset: readNumber(query, "preset"),
        waveSkip,
        shipState: readNumber(query, "ship"),
        disabledSystems,
        enabledSystems,
        seed: readNumber(query, "seed") ?? 1,
        selfTest: query.get("selftest") === "1",
        hudVisible: query.get("hud") !== "0",
        debug: query.get("debug") === "1",
        allocationPolicy: query.get("allocation") === "steps" ? "steps" : "max",
    };
}
