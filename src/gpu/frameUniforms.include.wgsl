struct FrameUniforms {
    jitteredViewProjection: mat4x4f,
    viewProjection: mat4x4f,
    previousViewProjection: mat4x4f,
    inverseViewProjection: mat4x4f,
    view: mat4x4f,
    cameraPositionAndTime: vec4f,
    previousCameraPositionAndDeltaTime: vec4f,
    jitterNdcAndInternalSize: vec4f,
    outputSizeAndRenderScale: vec4f,
    keyLightDirectionAndAngularRadius: vec4f,
    keyLightRadianceAndFrameIndex: vec4f,
    cameraForwardAndNearPlane: vec4f,
};
