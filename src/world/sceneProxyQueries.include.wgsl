const ASTRONAUT_CAPSULE_COUNT: u32 = 12u;
const ASTRONAUT_SUBMERGED_CAPSULE_COUNT: u32 = 6u;

fn astronautCapsuleStart(capsule: u32) -> vec4f {
    return sceneProxies.astronautCapsules[capsule * 2u];
}

fn astronautCapsuleEnd(capsule: u32) -> vec4f {
    return sceneProxies.astronautCapsules[capsule * 2u + 1u];
}

fn closestDistanceBetweenSegments(firstStart: vec3f, firstEnd: vec3f, secondStart: vec3f, secondEnd: vec3f) -> vec2f {
    let firstDirection = firstEnd - firstStart;
    let secondDirection = secondEnd - secondStart;
    let between = firstStart - secondStart;
    let firstLengthSquared = dot(firstDirection, firstDirection);
    let secondLengthSquared = dot(secondDirection, secondDirection);
    let secondAlongBetween = dot(secondDirection, between);
    var firstFraction = 0.0;
    var secondFraction = 0.0;
    if (firstLengthSquared <= 1e-10 && secondLengthSquared <= 1e-10) {
        return vec2f(length(between), 0.0);
    }
    if (firstLengthSquared <= 1e-10) {
        secondFraction = clamp(secondAlongBetween / secondLengthSquared, 0.0, 1.0);
    } else {
        let firstAlongBetween = dot(firstDirection, between);
        if (secondLengthSquared <= 1e-10) {
            firstFraction = clamp(-firstAlongBetween / firstLengthSquared, 0.0, 1.0);
        } else {
            let directionsDot = dot(firstDirection, secondDirection);
            let denominator = firstLengthSquared * secondLengthSquared - directionsDot * directionsDot;
            if (denominator > 1e-10) {
                firstFraction = clamp((directionsDot * secondAlongBetween - firstAlongBetween * secondLengthSquared) / denominator, 0.0, 1.0);
            }
            secondFraction = (directionsDot * firstFraction + secondAlongBetween) / secondLengthSquared;
            if (secondFraction < 0.0) {
                secondFraction = 0.0;
                firstFraction = clamp(-firstAlongBetween / firstLengthSquared, 0.0, 1.0);
            } else if (secondFraction > 1.0) {
                secondFraction = 1.0;
                firstFraction = clamp((directionsDot - firstAlongBetween) / firstLengthSquared, 0.0, 1.0);
            }
        }
    }
    let closestOnFirst = firstStart + firstDirection * firstFraction;
    let closestOnSecond = secondStart + secondDirection * secondFraction;
    return vec2f(length(closestOnFirst - closestOnSecond), firstFraction * sqrt(firstLengthSquared));
}

fn capsuleOcclusion(rayStart: vec3f, rayEnd: vec3f, capsuleStart: vec3f, capsuleEnd: vec3f, radius: f32, penumbraPerMetre: f32) -> f32 {
    let closest = closestDistanceBetweenSegments(rayStart, rayEnd, capsuleStart, capsuleEnd);
    let penumbra = 0.01 + closest.y * penumbraPerMetre;
    return 1.0 - smoothstep(radius - penumbra, radius + penumbra, closest.x);
}

fn astronautShadowVisibility(point: vec3f, waterDirection: vec3f, waterLength: f32, airDirection: vec3f, penumbraPerMetre: f32) -> f32 {
    let bounds = sceneProxies.astronautBoundsAndEnabled;
    if (bounds.w <= 0.0) {
        return 1.0;
    }
    let exitPoint = point + waterDirection * waterLength;
    let airEnd = exitPoint + airDirection * 3.0;
    let boundsStart = vec3f(bounds.x, bounds.y - 0.95, bounds.z);
    let boundsEnd = vec3f(bounds.x, bounds.y + 0.95, bounds.z);
    let nearWater = capsuleOcclusion(point, exitPoint, boundsStart, boundsEnd, bounds.w, penumbraPerMetre);
    let nearAir = capsuleOcclusion(exitPoint, airEnd, boundsStart, boundsEnd, bounds.w, penumbraPerMetre);
    if (max(nearWater, nearAir) <= 0.0) {
        return 1.0;
    }
    var visibility = 1.0;
    for (var capsule = 0u; capsule < ASTRONAUT_CAPSULE_COUNT; capsule++) {
        let start = astronautCapsuleStart(capsule);
        let end = astronautCapsuleEnd(capsule);
        visibility *= 1.0 - capsuleOcclusion(point, exitPoint, start.xyz, end.xyz, start.w, penumbraPerMetre * 0.75);
        visibility *= 1.0 - capsuleOcclusion(exitPoint, airEnd, start.xyz, end.xyz, start.w, penumbraPerMetre);
    }
    return visibility;
}

fn capsuleRayDistance(origin: vec3f, direction: vec3f, start: vec3f, end: vec3f, radius: f32) -> f32 {
    let axis = end - start;
    let fromStart = origin - start;
    let axisLengthSquared = dot(axis, axis);
    let axisAlongDirection = dot(axis, direction);
    let axisAlongOrigin = dot(axis, fromStart);
    let directionAlongOrigin = dot(direction, fromStart);
    let originLengthSquared = dot(fromStart, fromStart);
    let a = axisLengthSquared - axisAlongDirection * axisAlongDirection;
    let b = axisLengthSquared * directionAlongOrigin - axisAlongOrigin * axisAlongDirection;
    let c = axisLengthSquared * originLengthSquared - axisAlongOrigin * axisAlongOrigin - radius * radius * axisLengthSquared;
    let discriminant = b * b - a * c;
    if (discriminant < 0.0) {
        return -1.0;
    }
    var alongAxis = -1.0;
    if (abs(a) > 1e-10) {
        let distance = (-b - sqrt(discriminant)) / a;
        alongAxis = axisAlongOrigin + distance * axisAlongDirection;
        if (alongAxis > 0.0 && alongAxis < axisLengthSquared) {
            return distance;
        }
    }
    let fromCap = select(origin - end, fromStart, alongAxis <= 0.0);
    let halfB = dot(direction, fromCap);
    let capC = dot(fromCap, fromCap) - radius * radius;
    let capDiscriminant = halfB * halfB - capC;
    return select(-1.0, -halfB - sqrt(max(capDiscriminant, 0.0)), capDiscriminant > 0.0);
}

fn astronautSubmergedHit(origin: vec3f, direction: vec3f, maximumDistance: f32) -> vec4f {
    var best = vec4f(-1.0, 0.0, 0.0, 0.0);
    let bounds = sceneProxies.astronautBoundsAndEnabled;
    if (bounds.w <= 0.0) {
        return best;
    }
    if (length(origin.xz - bounds.xz) > 1.6) {
        return best;
    }
    var nearest = maximumDistance;
    for (var capsule = 0u; capsule < ASTRONAUT_SUBMERGED_CAPSULE_COUNT; capsule++) {
        let start = astronautCapsuleStart(capsule);
        let end = astronautCapsuleEnd(capsule);
        let distance = capsuleRayDistance(origin, direction, start.xyz, end.xyz, start.w);
        if (distance > 0.0 && distance < nearest) {
            nearest = distance;
            best = vec4f(distance, f32(capsule), end.w, 1.0);
        }
    }
    return best;
}

fn astronautCapsuleNormal(point: vec3f, capsule: u32) -> vec3f {
    let start = astronautCapsuleStart(capsule);
    let end = astronautCapsuleEnd(capsule);
    let axis = end.xyz - start.xyz;
    let along = clamp(dot(point - start.xyz, axis) / max(dot(axis, axis), 1e-8), 0.0, 1.0);
    return normalize(point - (start.xyz + axis * along));
}

fn astronautProxyAlbedo(materialCode: f32) -> vec3f {
    if (materialCode < 0.5) {
        return vec3f(0.36, 0.35, 0.33);
    }
    return vec3f(0.05, 0.05, 0.055);
}

fn boxSignedDistance(localPoint: vec3f, halfSize: vec3f) -> f32 {
    let outside = abs(localPoint) - halfSize;
    return length(max(outside, vec3f(0.0))) + min(max(outside.x, max(outside.y, outside.z)), 0.0);
}

fn shipBoxOcclusion(rayStart: vec3f, rayDirection: vec3f, rayLength: f32, box: u32, penumbraPerMetre: f32) -> f32 {
    let centre = sceneProxies.shipBoxes[box * 4u].xyz;
    let axisX = sceneProxies.shipBoxes[box * 4u + 1u];
    let axisY = sceneProxies.shipBoxes[box * 4u + 2u];
    let axisZ = sceneProxies.shipBoxes[box * 4u + 3u];
    let relative = rayStart - centre;
    let localOrigin = vec3f(dot(relative, axisX.xyz), dot(relative, axisY.xyz), dot(relative, axisZ.xyz));
    let localDirection = vec3f(dot(rayDirection, axisX.xyz), dot(rayDirection, axisY.xyz), dot(rayDirection, axisZ.xyz));
    let halfSize = vec3f(axisX.w, axisY.w, axisZ.w);
    let closestToCentre = clamp(-dot(localOrigin, localDirection), 0.0, rayLength);
    let reach = length(halfSize);
    var nearestDistance = 1e9;
    var distanceAlong = closestToCentre;
    for (var sampleIndex = -2; sampleIndex <= 2; sampleIndex++) {
        let along = clamp(closestToCentre + f32(sampleIndex) * reach * 0.45, 0.0, rayLength);
        let distance = boxSignedDistance(localOrigin + localDirection * along, halfSize);
        if (distance < nearestDistance) {
            nearestDistance = distance;
            distanceAlong = along;
        }
    }
    let penumbra = 0.03 + distanceAlong * penumbraPerMetre;
    return 1.0 - smoothstep(-penumbra, penumbra, nearestDistance);
}

fn shipSubmergedHit(origin: vec3f, direction: vec3f, maximumDistance: f32) -> vec4f {
    var best = vec4f(-1.0, 0.0, 1.0, 0.0);
    let bounds = sceneProxies.shipSubmergedBounds;
    if (bounds.w <= 0.0) {
        return best;
    }
    let toCentre = bounds.xyz - origin;
    let along = clamp(dot(toCentre, direction), 0.0, maximumDistance);
    if (length(toCentre - direction * along) > bounds.w) {
        return best;
    }
    let count = u32(sceneProxies.shipBoxCount.x + 0.5);
    var nearest = maximumDistance;
    for (var box = 0u; box < count; box++) {
        let centre = sceneProxies.shipBoxes[box * 4u];
        if (centre.w < 0.5) {
            continue;
        }
        let axisX = sceneProxies.shipBoxes[box * 4u + 1u];
        let axisY = sceneProxies.shipBoxes[box * 4u + 2u];
        let axisZ = sceneProxies.shipBoxes[box * 4u + 3u];
        let relative = origin - centre.xyz;
        let localOrigin = vec3f(dot(relative, axisX.xyz), dot(relative, axisY.xyz), dot(relative, axisZ.xyz));
        let localDirection = vec3f(dot(direction, axisX.xyz), dot(direction, axisY.xyz), dot(direction, axisZ.xyz));
        let halfSize = vec3f(axisX.w, axisY.w, axisZ.w);
        let safeDirection = select(vec3f(1e-6), localDirection, abs(localDirection) > vec3f(1e-6));
        let first = (-halfSize - localOrigin) / safeDirection;
        let second = (halfSize - localOrigin) / safeDirection;
        let nearCorner = min(first, second);
        let farCorner = max(first, second);
        let entry = max(max(nearCorner.x, nearCorner.y), nearCorner.z);
        let exit = min(min(farCorner.x, farCorner.y), farCorner.z);
        if (entry > 0.0 && entry <= exit && entry < nearest) {
            nearest = entry;
            var localNormal = vec3f(0.0, 0.0, -sign(safeDirection.z));
            if (entry == nearCorner.x) {
                localNormal = vec3f(-sign(safeDirection.x), 0.0, 0.0);
            } else if (entry == nearCorner.y) {
                localNormal = vec3f(0.0, -sign(safeDirection.y), 0.0);
            }
            best = vec4f(entry, axisX.xyz * localNormal.x + axisY.xyz * localNormal.y + axisZ.xyz * localNormal.z);
        }
    }
    return best;
}

fn shipShadowVisibility(point: vec3f, lightDirection: vec3f, penumbraPerMetre: f32) -> f32 {
    let count = u32(sceneProxies.shipBoxCount.x + 0.5);
    if (count == 0u) {
        return 1.0;
    }
    let bounds = sceneProxies.shipBounds;
    let rayLength = 80.0;
    let toCentre = bounds.xyz - point;
    let along = clamp(dot(toCentre, lightDirection), 0.0, rayLength);
    let missDistance = length(toCentre - lightDirection * along);
    if (missDistance > bounds.w + 0.03 + along * penumbraPerMetre) {
        return 1.0;
    }
    var visibility = 1.0;
    for (var box = 0u; box < count; box++) {
        let toBox = sceneProxies.shipBoxes[box * 4u].xyz - point;
        let boxAlong = clamp(dot(toBox, lightDirection), 0.0, rayLength);
        let boxReach = length(vec3f(sceneProxies.shipBoxes[box * 4u + 1u].w, sceneProxies.shipBoxes[box * 4u + 2u].w, sceneProxies.shipBoxes[box * 4u + 3u].w));
        if (length(toBox - lightDirection * boxAlong) > boxReach + 0.03 + boxAlong * penumbraPerMetre) {
            continue;
        }
        visibility *= 1.0 - shipBoxOcclusion(point, lightDirection, rayLength, box, penumbraPerMetre);
    }
    return visibility;
}
