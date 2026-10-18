const TAU: f32 = 6.28318530717959;

@group(0) @binding(0) var noiseOutput: texture_storage_2d<rgba16float, write>;

fn hash32(value: u32) -> u32 {
  let state = value * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

fn periodicGradient(cell: vec2i, period: vec2i, seed: u32) -> vec2f {
  let wrapped = ((cell % period) + period) % period;
  let hashed = hash32((bitcast<u32>(wrapped.x) * 0x8da6b343u) ^ (bitcast<u32>(wrapped.y) * 0xd8163841u) ^ (seed * 0xcb1ab31fu));
  let angle = f32(hashed >> 8u) * (TAU / 16777216.0);
  return vec2f(cos(angle), sin(angle));
}

fn periodicNoise(position: vec2f, period: vec2i, seed: u32) -> f32 {
  let cellFloor = floor(position);
  let local = position - cellFloor;
  let cell = vec2i(cellFloor);
  let fade = local * local * local * (local * (local * 6.0 - 15.0) + 10.0);
  let a = dot(periodicGradient(cell, period, seed), local);
  let b = dot(periodicGradient(cell + vec2i(1, 0), period, seed), local - vec2f(1.0, 0.0));
  let c = dot(periodicGradient(cell + vec2i(0, 1), period, seed), local - vec2f(0.0, 1.0));
  let d = dot(periodicGradient(cell + vec2i(1, 1), period, seed), local - vec2f(1.0, 1.0));
  return 1.414 * mix(mix(a, b, fade.x), mix(c, d, fade.x), fade.y);
}

fn periodicFbm(uv: vec2f, basePeriod: vec2i, octaves: i32, seed: u32, gain: f32) -> f32 {
  var sum = 0.0;
  var amplitude = 0.5;
  var period = basePeriod;
  for (var octave = 0; octave < octaves; octave++) {
    sum += amplitude * periodicNoise(uv * vec2f(period), period, seed + u32(octave) * 7919u);
    period = period * 2;
    amplitude *= gain;
  }
  return sum;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) invocation: vec3u) {
    let size = textureDimensions(noiseOutput);
    if (invocation.x >= size.x || invocation.y >= size.y) {
        return;
    }
    let uv = (vec2f(invocation.xy) + 0.5) / vec2f(size);
    let warp = vec2f(periodicFbm(uv, vec2i(4, 3), 4, 11u, 0.5), periodicFbm(uv, vec2i(4, 3), 4, 23u, 0.5));
    let warpedUv = uv + warp * vec2f(0.05, 0.09);
    let turbulence = periodicFbm(warpedUv, vec2i(16, 7), 5, 101u, 0.5);
    let streaks = periodicFbm(uv + warp * vec2f(0.02, 0.012), vec2i(3, 30), 3, 211u, 0.5);
    let detail = periodicFbm(warpedUv, vec2i(48, 12), 3, 307u, 0.5);
    let largeScale = periodicFbm(uv, vec2i(3, 2), 3, 401u, 0.5);
    textureStore(noiseOutput, vec2i(invocation.xy), vec4f(turbulence, streaks, detail, largeScale));
}
