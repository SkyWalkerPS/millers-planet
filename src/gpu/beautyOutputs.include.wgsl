const SURFACE_CODE_SKY: f32 = 0.0;
const SURFACE_CODE_SOLID: f32 = 1.0;
const SURFACE_CODE_SEA: f32 = 2.0;
const SURFACE_CODE_CHARACTER: f32 = 3.0;
const SURFACE_CODE_WAVE: f32 = 4.0;
const SKY_VIEW_DEPTH_METRES: f32 = 60000.0;

fn screenMotionFromClipPositions(currentClip: vec4f, previousClip: vec4f) -> vec2f {
    let currentNdc = currentClip.xy / max(currentClip.w, 1e-6);
    let previousNdc = previousClip.xy / max(previousClip.w, 1e-6);
    return (currentNdc - previousNdc) * 0.5;
}

fn packMotionDepthAndSurface(currentClip: vec4f, previousClip: vec4f, surfaceCode: f32) -> vec4f {
    return vec4f(screenMotionFromClipPositions(currentClip, previousClip), currentClip.w, surfaceCode);
}
