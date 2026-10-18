#include<frameUniforms>
#include<waveReservationParameters>

attribute position: vec3f;
var<uniform> frame: FrameUniforms;
var<uniform> waveReservation: WaveReservationParameters;
varying vWorldPosition: vec3f;
varying vProfile: vec2f;

fn profileHeight(acrossMetres: f32) -> f32 {
    let widths = waveReservation.shapeWidths;
    let scaled = acrossMetres / widths.x;
    let hyperbolicSecant = 1.0 / cosh(clamp(scaled, -20.0, 20.0));
    return waveReservation.travelDirectionAndHeight.w * hyperbolicSecant * hyperbolicSecant;
}

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    let along = (vertexInputs.position.x * 2.0 - 1.0) * waveReservation.shapeWidths.y;
    let across = (vertexInputs.position.z * 2.0 - 1.0) * waveReservation.shapeWidths.z;
    let travel = normalize(waveReservation.travelDirectionAndHeight.xz);
    let frontLine = vec2f(-travel.y, travel.x);
    let centre = waveReservation.frontCentreAndDistance.xz - travel * waveReservation.frontCentreAndDistance.w;
    let horizontal = centre + frontLine * along - travel * across;
    let world = vec3f(horizontal.x, profileHeight(across), horizontal.y);
    vertexOutputs.position = frame.jitteredViewProjection * vec4f(world, 1.0);
    vertexOutputs.vWorldPosition = world;
    vertexOutputs.vProfile = vec2f(across, along);
}
