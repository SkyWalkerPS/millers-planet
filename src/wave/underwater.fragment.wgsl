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
varying vScreenNdc: vec2f;

#include<gargantuaSampling>
#include<skyComposite>

const WATER_INDEX: f32 = 1.333;
const WINDOW_EXTINCTION: vec3f = vec3f(0.30, 0.060, 0.035);
const WINDOW_PATH_METRES: f32 = 5.0;

fn waterToAirTransmittance(cosineIncidence: f32) -> f32 {
    let sineTransmitted = WATER_INDEX * sqrt(max(1.0 - cosineIncidence * cosineIncidence, 0.0));
    if (sineTransmitted >= 1.0) {
        return 0.0;
    }
    let cosineTransmitted = sqrt(1.0 - sineTransmitted * sineTransmitted);
    let perpendicular = (WATER_INDEX * cosineIncidence - cosineTransmitted) / (WATER_INDEX * cosineIncidence + cosineTransmitted);
    let parallel = (WATER_INDEX * cosineTransmitted - cosineIncidence) / (WATER_INDEX * cosineTransmitted + cosineIncidence);
    return 1.0 - 0.5 * (perpendicular * perpendicular + parallel * parallel);
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let unjitteredNdc = input.vScreenNdc - frame.jitterNdcAndInternalSize.xy;
    let pointAtInfinity = frame.inverseViewProjection * vec4f(unjitteredNdc, 0.0, 1.0);
    let direction = normalize(pointAtInfinity.xyz);
    let camera = frame.cameraPositionAndTime.xyz;
    let time = frame.cameraPositionAndTime.w;
    let medium = frame.underwaterMediumAndDensity;

    let toward = waveToward();
    let crestHeight = waveParameters.crestAlongHeightEnabled.y;
    let x = waveParameters.crestAlongHeightEnabled.x - dot(camera.xz, toward);
    let depthBelowSurface = max(waveProfileHeight(x, crestHeight) - camera.y, 0.0);
    let slope = waveProfileSlope(x, crestHeight);
    let wobble = vec2f(
        trigonometryFreeGradientNoiseTwo(direction.xz * 5.0 + vec2f(time * 0.9, 1.7)),
        trigonometryFreeGradientNoiseTwo(direction.zx * 5.0 + vec2f(3.1, -time * 0.8)),
    ) * 0.07;
    let surfaceNormal = normalize(vec3f(slope * toward.x + wobble.x, 1.0, slope * toward.y + wobble.y));
    let depthDimming = mix(1.0, 0.4, smoothstep(0.0, 350.0, depthBelowSurface));
    let lookUp = smoothstep(-0.7, 0.85, direction.y);
    var radiance = medium.rgb * mix(0.3, 1.35, lookUp) * depthDimming;

    let cosineIncidence = dot(direction, surfaceNormal);
    if (cosineIncidence > 0.0) {
        let refracted = refract(direction, -surfaceNormal, WATER_INDEX);
        if (dot(refracted, refracted) > 1e-6) {
            let sky = skyRadianceBlurred(normalize(vec3f(refracted.x, max(refracted.y, 0.002), refracted.z)), 1.5, 1.5);
            let pathTransmission = exp(-WINDOW_EXTINCTION * (WINDOW_PATH_METRES / max(cosineIncidence, 0.15)));
            radiance += sky * (waterToAirTransmittance(cosineIncidence) * depthDimming) * pathTransmission;
        }
        let aroundWindow = acos(clamp(cosineIncidence, -1.0, 1.0));
        let azimuth = atan2(dot(direction, vec3f(toward.y, 0.0, -toward.x)), dot(direction, vec3f(toward.x, 0.0, toward.y)));
        let shafts = smoothstep(0.35, 0.95, trigonometryFreeGradientNoiseTwo(vec2f(azimuth * 7.0, time * 0.35)) * 0.5 + 0.5);
        radiance += medium.rgb * (shafts * 0.9 * (1.0 - smoothstep(0.15, 1.1, aroundWindow)) * depthDimming);
    }

    if (direction.y < -0.02) {
        let distanceToFloor = (camera.y + 0.2) / -direction.y;
        let floorPoint = camera.xz + direction.xz * distanceToFloor;
        let sand = 0.75 + 0.25 * trigonometryFreeGradientNoiseTwo(floorPoint * 1.7);
        let floorTransmission = exp(-medium.w * distanceToFloor);
        let floorRadiance = medium.rgb * (2.2 * sand) * depthDimming;
        radiance = mix(radiance, floorRadiance, floorTransmission);
    }

    let bubbleField = cellularNearestDistance(input.vScreenNdc * vec2f(9.0, 5.5) + vec2f(0.0, -time * 0.9));
    let bubbles = (1.0 - smoothstep(0.035, 0.075, bubbleField)) * smoothstep(0.02, 0.05, bubbleField + 0.02);
    radiance += medium.rgb * (bubbles * 2.5);

    let currentClip = frame.viewProjection * vec4f(direction, 0.0);
    let previousClip = frame.previousViewProjection * vec4f(direction, 0.0);
    fragmentOutputs.fragData0 = vec4f(radiance, 1.0);
    fragmentOutputs.fragData1 = vec4f(screenMotionFromClipPositions(currentClip, previousClip), SKY_VIEW_DEPTH_METRES, SURFACE_CODE_SKY);
}
