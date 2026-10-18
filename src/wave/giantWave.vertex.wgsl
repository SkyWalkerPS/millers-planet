#include<frameUniforms>
#include<proceduralNoise>
#include<waveShape>

attribute position: vec3f;
var<uniform> frame: FrameUniforms;
var<uniform> waveParameters: WaveParameters;
varying vWorldPosition: vec3f;
varying vPreviousWorldPosition: vec3f;
varying vProfile: vec4f;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    let lateralParameter = vertexInputs.position.x;
    let acrossParameter = vertexInputs.position.z;
    let placement = waveParameters.previousCrestAlongLateralCentreHalfExtent;
    let lateral = placement.y + sign(lateralParameter) * lateralParameter * lateralParameter * placement.z;
    let absoluteLateral = lateral + placement.w;
    let local = waveLocalShape(absoluteLateral);
    let crestHeight = waveParameters.crestAlongHeightEnabled.y * local.x;
    let extent = select(waveBackWidth() + 40.0, waveFrontWidth() + 40.0, acrossParameter >= 0.0);
    let x = acrossParameter * acrossParameter * acrossParameter * extent;
    let crestAlong = waveParameters.crestAlongHeightEnabled.x - local.y;
    let along = crestAlong - x;
    let toward = waveToward();
    let lateralDirection = waveLateralDirection();
    let horizontal = toward * along + lateralDirection * lateral;
    let world = vec3f(horizontal.x, waveProfileHeight(x, crestHeight), horizontal.y);
    let previousHorizontal = horizontal + toward * (placement.x - waveParameters.crestAlongHeightEnabled.x);
    vertexOutputs.position = frame.jitteredViewProjection * vec4f(world, 1.0);
    vertexOutputs.vWorldPosition = world;
    vertexOutputs.vPreviousWorldPosition = vec3f(previousHorizontal.x, world.y, previousHorizontal.y);
    vertexOutputs.vProfile = vec4f(x, absoluteLateral, crestHeight, crestHeight - world.y);
}
