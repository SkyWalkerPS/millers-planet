fn seabedDepthAt(position: vec2f) -> f32 {
    let shape = seaSurface.seabedShape;
    let broad = trigonometryFreeGradientNoiseTwo(position * shape.y) * 0.7 + trigonometryFreeGradientNoiseTwo(position * shape.y * 2.7 + vec2f(5.1, 1.7)) * 0.3;
    return seaSurface.waterScatteringColourAndDepth.w + shape.x * broad;
}

fn pebbleCoverage(position: vec2f, cellsPerMetre: f32, seedOffset: vec2f, footprintMetres: f32, toneRange: vec2f) -> vec2f {
    let scaled = position * cellsPerMetre + seedOffset;
    let cellFloor = floor(scaled);
    let local = scaled - cellFloor;
    let cell = vec2i(cellFloor);
    let nearerSide = vec2i(select(vec2f(-1.0), vec2f(0.0), local >= vec2f(0.5)));
    var coverage = 0.0;
    var tone = 1.0;
    for (var row = 0; row <= 1; row++) {
        for (var column = 0; column <= 1; column++) {
            let neighbour = nearerSide + vec2i(column, row);
            let random = latticeOffsetTwo(cell + neighbour);
            let centre = vec2f(neighbour) + random * 0.8 + 0.1;
            let radius = mix(0.12, 0.42, fract(random.x * 7.13 + random.y * 3.71));
            let stretched = (local - centre) * vec2f(1.0, mix(0.7, 1.3, random.y));
            let distanceToCentre = length(stretched);
            let edgeWidth = max(radius * 0.14, footprintMetres * cellsPerMetre * 1.5);
            let inside = 1.0 - smoothstep(radius - edgeWidth, radius, distanceToCentre);
            if (inside > coverage) {
                coverage = inside;
                let contactShadow = 1.0 - 0.3 * smoothstep(radius * 0.72, radius, distanceToCentre);
                let dome = 1.0 - 0.12 * smoothstep(radius * 0.2, radius * 0.8, distanceToCentre);
                tone = mix(toneRange.x, toneRange.y, fract(random.x * 13.7 + random.y * 5.3)) * contactShadow * dome;
            }
        }
    }
    return vec2f(coverage, tone);
}

fn sandGrainSpeckle(position: vec2f, footprintMetres: f32) -> f32 {
    let coarseVisibility = 1.0 - smoothstep(0.0015, 0.004, footprintMetres);
    let fineVisibility = 1.0 - smoothstep(0.0006, 0.0016, footprintMetres);
    let coarse = trigonometryFreeGradientNoiseTwo(position * 260.0 + vec2f(7.7, 3.1)) * coarseVisibility;
    let fine = trigonometryFreeGradientNoiseTwo(position * 720.0 + vec2f(1.9, 5.4)) * fineVisibility;
    return 1.0 + 0.2 * coarse + 0.16 * fine;
}

fn seabedAlbedoAt(position: vec2f, footprintMetres: f32) -> vec3f {
    let shape = seaSurface.seabedShape;
    let coarseDetail = 1.0 - smoothstep(0.04, 0.12, footprintMetres);
    let fineDetail = 1.0 - smoothstep(0.015, 0.05, footprintMetres);
    let mottling = trigonometryFreeGradientNoiseTwo(position * 1.3) * 0.5 + 0.5;
    let sandPatches = smoothstep(0.15, 0.55, trigonometryFreeGradientNoiseTwo(position * 0.45 + vec2f(9.3, 4.1)) * 0.5 + 0.5);
    var albedo = mix(shape.z, shape.z * 1.6, mottling * 0.6 + sandPatches * 0.4);
    albedo = mix(albedo, shape.w, sandPatches * 0.25);
    if (footprintMetres < 0.004) {
        albedo *= sandGrainSpeckle(position, footprintMetres);
    }
    if (coarseDetail > 0.0) {
        let stones = pebbleCoverage(position, 4.0, vec2f(1.3, 7.9), footprintMetres, vec2f(0.45, 2.0));
        albedo = mix(albedo, albedo * stones.y, stones.x * coarseDetail);
    }
    if (fineDetail > 0.0) {
        let gravel = pebbleCoverage(position, 13.0, vec2f(4.2, 2.6), footprintMetres, vec2f(0.6, 1.35));
        albedo = mix(albedo, albedo * gravel.y, gravel.x * fineDetail * 0.7);
    }
    return vec3f(albedo) * vec3f(0.94, 1.0, 1.03);
}

struct SeabedRippleMarkRelief {
    gradient: vec2f,
    crestFraction: f32,
};

fn seabedRippleMarkMeander(position: vec2f) -> f32 {
    return trigonometryFreeGradientNoiseTwo(position * 2.1 + vec2f(3.7, 8.2)) * 0.035;
}

fn seabedRippleMarkRelief(position: vec2f, footprintMetres: f32) -> SeabedRippleMarkRelief {
    let marks = seaSurface.seabedRippleMarks;
    let visibility = 1.0 - smoothstep(marks.y * 0.2, marks.y * 0.6, footprintMetres);
    var relief = SeabedRippleMarkRelief(vec2f(0.0), 0.5);
    if (visibility <= 0.0) {
        return relief;
    }
    let crestNormal = marks.zw;
    let wavenumber = 6.2831853 / marks.y;
    let finiteStep = 0.01;
    let meander = seabedRippleMarkMeander(position);
    let meanderGradient = vec2f(seabedRippleMarkMeander(position + vec2f(finiteStep, 0.0)) - meander, seabedRippleMarkMeander(position + vec2f(0.0, finiteStep)) - meander) / finiteStep;
    let phase = wavenumber * (dot(position, crestNormal) + meander);
    let strength = marks.x * visibility * (0.55 + 0.45 * trigonometryFreeGradientNoiseTwo(position * 1.7 + vec2f(6.1, 0.4)));
    let rise = 0.5 + 0.5 * sin(phase);
    relief.gradient = 2.0 * strength * rise * cos(phase) * wavenumber * (crestNormal + meanderGradient);
    relief.crestFraction = mix(0.5, rise * rise, visibility);
    return relief;
}
