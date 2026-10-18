const SPAN_NAMES = ['spanMs', 'gpuSpanMs', 'gpuTotalMs', 'spans', 'gpuTimes'];
const BUSY_NAMES = ['busyMs', 'gpuBusyMs', 'busy'];
const PASS_NAMES = ['passMs', 'gpuPassMs', 'passes'];
const LABEL_NAMES = ['labelNames', 'passNames', 'labels'];
const SCALE_NAMES = ['scale', 'scales', 'renderScale'];
const INTERVAL_NAMES = ['intervalMs', 'intervals', 'wallIntervals', 'rafIntervalMs'];
const GENERATION_NAMES = ['generation', 'generations', 'renderTargetGeneration'];
const PIPELINE_NAMES = ['pipelinesCreated', 'pipelinesCreatedPerFrame'];
const CAMERA_MODE_NAMES = ['cameraModeCode', 'cameraMode'];
const SUBMITTED_NAMES = ['framesSubmitted', 'framesMeasured'];

function firstPresent(source, names) {
  for (const name of names) if (source && source[name] !== undefined && source[name] !== null) return source[name];
  return undefined;
}

function toPlainArray(value) {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value;
  if (ArrayBuffer.isView(value)) return Array.from(value);
  if (typeof value === 'object' && Object.keys(value).every((key) => /^\d+$/.test(key))) return Object.keys(value).sort((a, b) => a - b).map((key) => value[key]);
  return undefined;
}

function toNumberOrNaN(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : NaN;
}

export function passTimesByLabel(passValue, labelNames, frameCount) {
  if (!passValue) return {};
  const rows = toPlainArray(passValue);
  if (rows && rows.length && (Array.isArray(rows[0]) || ArrayBuffer.isView(rows[0]))) {
    const labels = labelNames || [];
    const byLabel = Object.fromEntries(labels.map((label) => [label, []]));
    rows.forEach((row) => labels.forEach((label, labelIndex) => byLabel[label].push(toNumberOrNaN(row[labelIndex]))));
    return byLabel;
  }
  if (typeof passValue === 'object' && !rows) {
    const byLabel = {};
    for (const [label, values] of Object.entries(passValue)) {
      const plainValues = toPlainArray(values);
      if (plainValues && (frameCount === undefined || plainValues.length === frameCount)) byLabel[label] = plainValues.map(toNumberOrNaN);
    }
    return byLabel;
  }
  return {};
}

export const SERIALISE_FOR_HARNESS_FUNCTION = `function serialiseForHarness(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (ArrayBuffer.isView(value)) return Array.from(value);
  if (Array.isArray(value)) return depth > 6 ? [] : value.map((item) => serialiseForHarness(item, depth + 1));
  if (typeof value === 'object') {
    if (depth > 6) return {};
    const plain = {};
    for (const [key, item] of Object.entries(value)) {
      if (typeof item !== 'function') plain[key] = serialiseForHarness(item, depth + 1);
    }
    return plain;
  }
  return value;
}`;

export function pageExpression(body) {
  return `(async () => { ${SERIALISE_FOR_HARNESS_FUNCTION}; return serialiseForHarness(await (${body})); })()`;
}

export function normaliseBenchmarkResult(rawResult) {
  if (!rawResult || typeof rawResult !== 'object') throw new Error(`millersPlanet.benchmark() returned ${JSON.stringify(rawResult)} instead of an object`);
  const spanValues = toPlainArray(firstPresent(rawResult, SPAN_NAMES));
  if (!spanValues) {
    throw new Error(`millersPlanet.benchmark() returned no per-frame GPU span array (looked for ${SPAN_NAMES.join(', ')}; keys present: ${Object.keys(rawResult).join(', ')})`);
  }
  const spanMs = spanValues.map(toNumberOrNaN);
  const frameCount = spanMs.length;
  const labelNames = toPlainArray(firstPresent(rawResult, LABEL_NAMES)) || toPlainArray(rawResult.gpu?.passNames);
  const pipelineValue = firstPresent(rawResult, PIPELINE_NAMES);
  const gpuCounters = rawResult.gpu || {};
  return {
    frameCount,
    spanMs,
    busyMs: (toPlainArray(firstPresent(rawResult, BUSY_NAMES)) || []).map(toNumberOrNaN),
    passMsByLabel: passTimesByLabel(firstPresent(rawResult, PASS_NAMES), labelNames, frameCount),
    scale: (toPlainArray(firstPresent(rawResult, SCALE_NAMES)) || []).map(toNumberOrNaN),
    intervalMs: (toPlainArray(firstPresent(rawResult, INTERVAL_NAMES)) || []).map(toNumberOrNaN),
    generation: (toPlainArray(firstPresent(rawResult, GENERATION_NAMES)) || []).map(toNumberOrNaN),
    pipelinesCreated: toPlainArray(pipelineValue) ?? (typeof pipelineValue === 'number' ? pipelineValue : null),
    framesRequested: rawResult.framesRequested ?? null,
    framesSubmitted: firstPresent(rawResult, SUBMITTED_NAMES) ?? gpuCounters.framesSubmitted ?? null,
    framesTimed: rawResult.framesTimed ?? gpuCounters.framesTimed ?? null,
    untimedFrames: typeof rawResult.untimedFrames === 'number' ? rawResult.untimedFrames : null,
    gpuErrors: toPlainArray(rawResult.gpuErrors) || [],
    output: toPlainArray(rawResult.output) || null,
    internal: toPlainArray(rawResult.internal) || null,
    keysPresent: Object.keys(rawResult),
  };
}

export function normaliseFrameLog(rawLog) {
  if (!rawLog || typeof rawLog !== 'object') throw new Error(`millersPlanet.frameLog() returned ${JSON.stringify(rawLog)} instead of an object`);
  const recordsFromList = Array.isArray(rawLog) ? rawLog : Array.isArray(rawLog.frames) ? rawLog.frames : null;
  if (recordsFromList) {
    return {
      records: recordsFromList.map((record) => ({
        frameIndex: record.frameIndex,
        rafTimeMs: toNumberOrNaN(record.rafTimeMs),
        gpuSpanMs: toNumberOrNaN(record.gpuSpanMs),
        gpuBusyMs: toNumberOrNaN(record.gpuBusyMs),
        passMs: record.passMs || {},
        scale: toNumberOrNaN(record.scale),
        generation: record.generation,
        wavePhaseCode: record.wavePhaseCode,
        cameraMode: firstPresent(record, CAMERA_MODE_NAMES),
      })),
      untimedFrames: rawLog.untimedFrames ?? 0,
      latestFrameIndex: rawLog.latestFrameIndex ?? null,
      labelNames: rawLog.labelNames || [],
    };
  }
  const frameIndices = toPlainArray(rawLog.frameIndex);
  const rafTimes = toPlainArray(rawLog.rafTimeMs);
  const spans = toPlainArray(rawLog.gpuSpanMs);
  if (!frameIndices || !rafTimes || !spans) {
    throw new Error(`millersPlanet.frameLog() is missing frameIndex, rafTimeMs or gpuSpanMs arrays (keys present: ${Object.keys(rawLog).join(', ')})`);
  }
  const labelNames = toPlainArray(firstPresent(rawLog, LABEL_NAMES)) || [];
  const passByLabel = passTimesByLabel(rawLog.passMs, labelNames, frameIndices.length);
  const busy = toPlainArray(rawLog.gpuBusyMs) || [];
  const clockSlowdowns = toPlainArray(rawLog.clockSlowdown) || [];
  const scales = toPlainArray(rawLog.scale) || [];
  const generations = toPlainArray(rawLog.generation) || [];
  const wavePhases = toPlainArray(rawLog.wavePhaseCode) || [];
  const cameraModes = toPlainArray(firstPresent(rawLog, CAMERA_MODE_NAMES)) || [];
  return {
    records: frameIndices.map((frameIndex, position) => ({
      frameIndex,
      rafTimeMs: toNumberOrNaN(rafTimes[position]),
      gpuSpanMs: toNumberOrNaN(spans[position]),
      gpuBusyMs: toNumberOrNaN(busy[position]),
      clockSlowdown: toNumberOrNaN(clockSlowdowns[position]),
      passMs: Object.fromEntries(Object.entries(passByLabel).map(([label, values]) => [label, values[position]])),
      scale: toNumberOrNaN(scales[position]),
      generation: generations[position],
      wavePhaseCode: wavePhases[position],
      cameraMode: cameraModes[position],
    })),
    untimedFrames: rawLog.untimedFrames ?? 0,
    latestFrameIndex: rawLog.latestFrameIndex ?? null,
    labelNames,
  };
}

export function normaliseCropRectangle(crop) {
  if (!crop) return null;
  const values = Array.isArray(crop) ? crop : [crop.x, crop.y, crop.width ?? crop.w, crop.height ?? crop.h];
  const [x, y, width, height] = values.map(Number);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}
