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
    for (const token of (query.get("systems") ?? "").split(",")) {
        const trimmed = token.trim();
        if (trimmed.startsWith("-") && trimmed.length > 1) {
            disabledSystems.push(trimmed.slice(1));
        }
    }
    return {
        pinnedScale: readNumber(query, "scale"),
        frozenTimeSeconds: readNumber(query, "time"),
        shotName: query.get("shot"),
        disabledSystems,
        hudVisible: query.get("hud") !== "0",
        allocationPolicy: query.get("allocation") === "steps" ? "steps" : "max",
    };
}
