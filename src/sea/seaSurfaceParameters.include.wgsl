struct SeaSurfaceParameters {
    clipmapCentreAndSpacing: vec4f,
    cascadeSizes: vec4f,
    cascadeInverseSizes: vec4f,
    displacementFadeLevelCurvature: vec4f,
    slopeOptics: vec4f,
    waterAbsorptionAndScattering: vec4f,
    waterScatteringColourAndDepth: vec4f,
    seabedShape: vec4f,
    rippleWindowCentreHalfTexel: vec4f,
    seabedRippleMarks: vec4f,
};

fn rippleWindowFade(world: vec2f) -> f32 {
    let window = seaSurface.rippleWindowCentreHalfTexel;
    let offset = world - window.xy;
    return 1.0 - smoothstep(0.80, 0.96, max(abs(offset.x), abs(offset.y)) / window.z);
}
