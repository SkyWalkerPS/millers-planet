const CLOUD_DECK_TAU: f32 = 6.28318530718;
const CLOUD_DECK_HALF_PI: f32 = 1.57079632679;

fn cloudDeckDirectionFromUv(uv: vec2f) -> vec3f {
    let azimuth = uv.x * CLOUD_DECK_TAU;
    let elevation = CLOUD_DECK_HALF_PI * uv.y * uv.y;
    let cosineElevation = cos(elevation);
    return vec3f(sin(azimuth) * cosineElevation, sin(elevation), cos(azimuth) * cosineElevation);
}

fn cloudDeckUvFromDirection(direction: vec3f) -> vec2f {
    let elevation = asin(clamp(direction.y, 0.0, 1.0));
    var azimuth = atan2(direction.x, direction.z);
    if (azimuth < 0.0) {
        azimuth += CLOUD_DECK_TAU;
    }
    return vec2f(azimuth / CLOUD_DECK_TAU, sqrt(elevation / CLOUD_DECK_HALF_PI));
}
