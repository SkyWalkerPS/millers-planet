fn applyAerialPerspective(radiance: vec3f, unjitteredClip: vec4f, viewDistanceMetres: f32) -> vec3f {
    let underwater = frame.underwaterMediumAndDensity;
    if (underwater.w > 0.0) {
        let waterTransmission = exp(-underwater.w * viewDistanceMetres);
        return radiance * waterTransmission + underwater.rgb * (1.0 - waterTransmission);
    }
    let screenUv = clamp(unjitteredClip.xy / max(unjitteredClip.w, 1e-6) * 0.5 + 0.5, vec2f(0.0), vec2f(1.0));
    let coordinates = vec3f(screenUv, aerialPerspectiveSliceCoordinate(viewDistanceMetres));
    let inscatterAndTransmittance = textureSampleLevel(aerialPerspectiveVolume, aerialPerspectiveVolumeSampler, coordinates, 0.0);
    let nearFade = aerialPerspectiveNearFade(viewDistanceMetres);
    return radiance * mix(1.0, inscatterAndTransmittance.a, nearFade) + inscatterAndTransmittance.rgb * (nearFade * frame.waveLightingAndHaze.z);
}
