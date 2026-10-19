#include<frameUniforms>
#include<beautyOutputs>
#include<atmosphereCore>
#include<cloudDeckLayout>
#include<aerialPerspectiveLayout>
#include<proceduralNoise>
#include<waveShape>

var<uniform> frame: FrameUniforms;
var<uniform> atmosphere: AtmosphereParameters;
var<uniform> waveParameters: WaveParameters;
var gargantuaCurrentPatch: texture_2d<f32>;
var gargantuaCurrentPatchSampler: sampler;
var gargantuaPreviousPatch: texture_2d<f32>;
var gargantuaPreviousPatchSampler: sampler;
var transmittanceLut: texture_2d<f32>;
var transmittanceLutSampler: sampler;
var skyViewLut: texture_2d<f32>;
var skyViewLutSampler: sampler;
var cloudDeckTexture: texture_2d<f32>;
var cloudDeckTextureSampler: sampler;
var aerialPerspectiveVolume: texture_3d<f32>;
var aerialPerspectiveVolumeSampler: sampler;
varying vWorldPosition: vec3f;
varying vPreviousWorldPosition: vec3f;
varying vProfile: vec4f;

#include<gargantuaSampling>
#include<skyComposite>
#include<aerialPerspectiveApply>
#include<cloudDeckLighting>

const WAVE_ABSORPTION: vec3f = vec3f(0.30, 0.050, 0.025);
const WAVE_CREST_SCATTERING: f32 = 0.06;
const WAVE_BODY_ALBEDO: vec3f = vec3f(0.012, 0.048, 0.056);

fn waveDetailHeight(faceCoordinates: vec2f, footprint: f32) -> f32 {
    var height = 16.0 * trigonometryFreeGradientNoiseTwo(faceCoordinates * vec2f(0.006, 0.0022));
    height += 4.0 * trigonometryFreeGradientNoiseTwo(faceCoordinates * vec2f(0.024, 0.008) + vec2f(3.1, 7.7)) * (1.0 - smoothstep(10.0, 40.0, footprint));
    height += 0.7 * trigonometryFreeGradientNoiseTwo(faceCoordinates * vec2f(0.09, 0.03) + vec2f(11.3, 1.9)) * (1.0 - smoothstep(3.0, 12.0, footprint));
    return height;
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let world = input.vWorldPosition;
    let x = input.vProfile.x;
    let lateral = input.vProfile.y;
    let crestHeight = input.vProfile.z;
    let depthBelowCrest = max(crestHeight - world.y, 0.0);
    let time = frame.cameraPositionAndTime.w;
    let toCamera = frame.cameraPositionAndTime.xyz - world;
    let viewDistance = length(toCamera);
    let view = toCamera / viewDistance;
    let footprint = max(length(fwidth(world)), 0.05);

    let raggedAmount = waveParameters.glowAndRaggedness.y * (0.5 + 0.35 * trigonometryFreeGradientNoiseTwo(vec2f(lateral * 0.045, 0.0)) + 0.25 * trigonometryFreeGradientNoiseTwo(vec2f(lateral * 0.17, 5.0)));
    if (abs(x) < 80.0 && depthBelowCrest < raggedAmount) {
        discard;
    }

    let toward = waveToward();
    let lateralDirection = waveLateralDirection();
    let slope = waveProfileSlope(x, crestHeight);
    var normal = normalize(vec3f(slope * toward.x, 1.0, slope * toward.y));
    let motion = waveParameters.glowAndRaggedness.z;
    let flowTime = waveParameters.glowAndRaggedness.w;
    let faceCoordinates = vec2f(lateral, world.y + flowTime * 9.0);
    let step = max(1.5, footprint);
    let detail = waveDetailHeight(faceCoordinates, footprint);
    let detailAcross = waveDetailHeight(faceCoordinates + vec2f(step, 0.0), footprint);
    let detailUp = waveDetailHeight(faceCoordinates + vec2f(0.0, step), footprint);
    let tangent = vec3f(lateralDirection.x, 0.0, lateralDirection.y);
    let bitangent = normalize(cross(normal, tangent));
    let detailStrength = 1.6 * smoothstep(0.0, 60.0, world.y);
    normal = normalize(normal - (tangent * (detailAcross - detail) + bitangent * (detailUp - detail)) / step * detailStrength);

    let lightDirection = atmosphere.lightDirectionAndCameraAltitude.xyz;
    let illuminance = atmosphere.lightIlluminanceAndMarineScaleHeight.xyz;
    let skyIrradiance = overcastBaseRadiancePerIlluminance(lightDirection, atmosphere) * illuminance * (ATMOSPHERE_PI * atmosphere.deckClearingCoverageInnerOuterOvercast.w * atmosphere.deckAmbientGainAndBakeOriginKilometres.x);
    let facing = max(dot(normal, view), 0.0);
    let fresnel = 0.02 + 0.98 * pow(1.0 - facing, 5.0);
    let reflected = reflect(-view, normal);
    let reflectedSky = skyRadianceBlurred(normalize(vec3f(reflected.x, max(reflected.y, 0.003), reflected.z)), 4.0, 3.0);
    let reflectedSea = skyIrradiance * WAVE_BODY_ALBEDO * (0.6 / ATMOSPHERE_PI);
    let reflection = mix(reflectedSea, reflectedSky, smoothstep(-0.08, 0.02, reflected.y));
    let ambient = skyIrradiance * (0.55 + 0.45 * max(normal.y, 0.0));
    var radiance = WAVE_BODY_ALBEDO / ATMOSPHERE_PI * ambient * (1.0 - fresnel) + reflection * fresnel;

    let streakField = trigonometryFreeGradientNoiseTwo(vec2f(lateral * 0.012, (world.y + flowTime * 22.0) * 0.0016)) * 0.65 + trigonometryFreeGradientNoiseTwo(vec2f(lateral * 0.04, (world.y + flowTime * 30.0) * 0.005) + vec2f(4.2, 0.0)) * 0.35;
    let streaks = smoothstep(0.25, 0.7, streakField) * smoothstep(0.0, 0.5, max(-slope, 0.0)) * (1.0 - smoothstep(40.0, 200.0, footprint));
    let foamColour = skyIrradiance * (0.42 / ATMOSPHERE_PI);
    radiance = mix(radiance, foamColour, streaks * 0.16);

    if (x >= -2.0) {
        let rayDirection = -view;
        let chord = waveCrestChordMetres(depthBelowCrest, crestHeight, rayDirection);
        let aeration = mix(0.12, 1.0, smoothstep(0.0, 70.0, depthBelowCrest));
        let extinction = (WAVE_ABSORPTION + vec3f(WAVE_CREST_SCATTERING)) * aeration;
        let transmittance = exp(-extinction * chord);
        let behind = skyRadianceAboveHorizon(normalize(vec3f(rayDirection.x, max(rayDirection.y, 0.002), rayDirection.z)));
        let keyIlluminance = illuminance * transmittanceToSpace(lightDirection);
        let forward = henyeyGreensteinPhase(dot(rayDirection, lightDirection), 0.85);
        let inscatter = keyIlluminance * forward * (WAVE_CREST_SCATTERING * aeration * min(chord, 400.0)) * transmittance;
        let glow = (behind * transmittance + inscatter) * (1.0 - fresnel) * waveParameters.glowAndRaggedness.x;
        let seeThrough = dot(transmittance, vec3f(0.25, 0.4, 0.35));
        radiance = radiance * (1.0 - seeThrough) + glow;
    }

    let mistHeight = (10.0 + 16.0 * motion) + (8.0 + 14.0 * motion) * (trigonometryFreeGradientNoiseTwo(vec2f(lateral * 0.008, flowTime * 0.12)) * 0.5 + 0.5);
    let mist = (1.0 - smoothstep(0.0, mistHeight, world.y)) * smoothstep(-40.0, 10.0, x);
    let mistColour = skyIrradiance * (0.62 / ATMOSPHERE_PI);
    radiance = mix(radiance, mistColour, mist * 0.85);

    let currentClip = frame.viewProjection * vec4f(world, 1.0);
    let previousClip = frame.previousViewProjection * vec4f(input.vPreviousWorldPosition, 1.0);
    radiance = mix(radiance, applyAerialPerspective(radiance, currentClip, viewDistance), WAVE_HAZE_KEPT);
    fragmentOutputs.fragData0 = vec4f(radiance, 1.0);
    fragmentOutputs.fragData1 = packMotionDepthAndSurface(currentClip, previousClip, SURFACE_CODE_WAVE);
}
