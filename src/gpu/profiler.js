import { getCurrentRenderTargetWrapper, getGpuDevice, getTimestampQueryHooks } from "./internals.js";
import { maximumProfiledLabelCount } from "./frameLog.js";

const maximumPassesPerFrame = 128;
const readbackRecordCount = 12;
const bytesPerPass = 16;
const quantizationProbeFrameCount = 300;
const quantizationThresholdNanoseconds = 1000;

function greatestCommonDivisor(first, second) {
    let larger = Math.abs(first);
    let smaller = Math.abs(second);
    while (smaller > 0.5) {
        const remainder = larger % smaller;
        larger = smaller;
        smaller = remainder;
    }
    return larger;
}

export class PassTimestampProfiler {
    constructor(engine, frameLog) {
        this.engine = engine;
        this.frameLog = frameLog;
        this.device = getGpuDevice(engine);
        this.isAvailable = engine.enabledExtensions.includes("timestamp-query");
        this.explicitLabel = null;
        this.passDescriptorPatcher = null;
        this.labelNames = [];
        this.labelIndexByName = new Map();
        this.currentFrameIndex = -1;
        this.currentFramePassCount = 0;
        this.currentFramePassLabelIndices = new Int32Array(maximumPassesPerFrame);
        this.currentFrameBeautyPassCount = 0;
        this.framesSubmitted = 0;
        this.framesTimed = 0;
        this.framesWithoutFreeReadback = 0;
        this.passesBeyondCapacity = 0;
        this.lastTimedFrameIndex = -1;
        this.lastSpanMilliseconds = 0;
        this.lastBusyMilliseconds = 0;
        this.lastExclusiveMillisecondsByLabel = new Float64Array(maximumProfiledLabelCount);
        this.scratchExclusiveMillisecondsByLabel = new Float64Array(maximumProfiledLabelCount);
        this.maximumBeautyPassesInOneFrame = 0;
        this.quantizationFramesExamined = 0;
        this.timestampGreatestCommonDivisorNanoseconds = 0;
        this.awaitingMapRecord = null;
        this.freeRecords = [];
        this.recordsInFlight = 0;
        this.timedFrameListeners = [];
        if (this.isAvailable) {
            this.querySet = this.device.createQuerySet({ type: "timestamp", count: maximumPassesPerFrame * 2, label: "passTimestampQuerySet" });
            this.resolveBuffer = this.device.createBuffer({ size: maximumPassesPerFrame * bytesPerPass, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC, label: "passTimestampResolve" });
            for (let recordIndex = 0; recordIndex < readbackRecordCount; recordIndex++) {
                const record = {
                    buffer: this.device.createBuffer({ size: maximumPassesPerFrame * bytesPerPass, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST, label: `passTimestampReadback${recordIndex}` }),
                    passCount: 0,
                    frameIndex: -1,
                    labelIndices: new Int32Array(maximumPassesPerFrame),
                    onMapped: null,
                    onMapFailed: null,
                };
                record.onMapped = () => this.processMappedRecord(record);
                record.onMapFailed = () => this.releaseRecord(record, false);
                this.freeRecords.push(record);
            }
        }
        this.installHooks();
    }

    get source() {
        return this.isAvailable ? "timestamp-query" : "none";
    }

    get quantizedSuspect() {
        return this.quantizationFramesExamined > 0 && this.timestampGreatestCommonDivisorNanoseconds >= quantizationThresholdNanoseconds;
    }

    installHooks() {
        const timestampQueryHooks = getTimestampQueryHooks(this.engine);
        timestampQueryHooks.startFrame = () => {};
        timestampQueryHooks.endPass = () => {};
        timestampQueryHooks.startPass = (descriptor) => this.beginPass(descriptor);
        timestampQueryHooks.endFrame = (encoder) => this.resolveFrame(encoder);
        this.engine.onEndFrameObservable.add(() => this.mapAwaitingRecord());
    }

    labelIndexFor(labelName) {
        let labelIndex = this.labelIndexByName.get(labelName);
        if (labelIndex === undefined) {
            if (this.labelNames.length >= maximumProfiledLabelCount) {
                return maximumProfiledLabelCount - 1;
            }
            labelIndex = this.labelNames.length;
            this.labelNames.push(labelName);
            this.labelIndexByName.set(labelName, labelIndex);
        }
        return labelIndex;
    }

    markFrameStart(frameIndex) {
        this.currentFrameIndex = frameIndex;
        this.currentFramePassCount = 0;
        this.currentFrameBeautyPassCount = 0;
    }

    beginPass(descriptor) {
        const isComputePass = descriptor.colorAttachments === undefined;
        let labelName = this.explicitLabel;
        if (labelName === null) {
            if (isComputePass) {
                labelName = "compute";
            } else {
                const renderTarget = getCurrentRenderTargetWrapper(this.engine);
                labelName = renderTarget ? renderTarget.label ?? "renderTarget" : "main";
            }
        }
        if (labelName === "beauty") {
            this.currentFrameBeautyPassCount++;
            if (this.currentFrameBeautyPassCount > this.maximumBeautyPassesInOneFrame) {
                this.maximumBeautyPassesInOneFrame = this.currentFrameBeautyPassCount;
            }
        }
        if (this.passDescriptorPatcher !== null) {
            this.passDescriptorPatcher(descriptor, labelName, isComputePass);
        }
        if (!this.isAvailable || this.currentFramePassCount >= maximumPassesPerFrame) {
            if (this.isAvailable) {
                this.passesBeyondCapacity++;
            }
            descriptor.timestampWrites = undefined;
            return;
        }
        const slot = this.currentFramePassCount++;
        this.currentFramePassLabelIndices[slot] = this.labelIndexFor(labelName);
        let timestampWrites = descriptor.timestampWrites;
        if (!timestampWrites || timestampWrites.querySet !== this.querySet) {
            timestampWrites = { querySet: this.querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 };
            descriptor.timestampWrites = timestampWrites;
        }
        timestampWrites.beginningOfPassWriteIndex = slot * 2;
        timestampWrites.endOfPassWriteIndex = slot * 2 + 1;
    }

    resolveFrame(encoder) {
        const passCount = this.currentFramePassCount;
        this.currentFramePassCount = 0;
        if (!this.isAvailable || passCount === 0) {
            return;
        }
        this.framesSubmitted++;
        const record = this.freeRecords.pop();
        if (!record) {
            this.framesWithoutFreeReadback++;
            return;
        }
        encoder.resolveQuerySet(this.querySet, 0, passCount * 2, this.resolveBuffer, 0);
        encoder.copyBufferToBuffer(this.resolveBuffer, 0, record.buffer, 0, passCount * bytesPerPass);
        record.passCount = passCount;
        record.frameIndex = this.currentFrameIndex;
        record.labelIndices.set(this.currentFramePassLabelIndices.subarray(0, passCount));
        this.awaitingMapRecord = record;
        this.recordsInFlight++;
    }

    mapAwaitingRecord() {
        const record = this.awaitingMapRecord;
        if (record === null) {
            return;
        }
        this.awaitingMapRecord = null;
        record.buffer.mapAsync(GPUMapMode.READ, 0, record.passCount * bytesPerPass).then(record.onMapped, record.onMapFailed);
    }

    releaseRecord(record, wasMapped) {
        if (wasMapped) {
            record.buffer.unmap();
        }
        this.recordsInFlight--;
        this.framesTimed++;
        this.freeRecords.push(record);
    }

    processMappedRecord(record) {
        const words = new Uint32Array(record.buffer.getMappedRange(0, record.passCount * bytesPerPass));
        const passCount = record.passCount;
        let referenceLow = 0;
        let referenceHigh = 0;
        let referenceFound = false;
        for (let passIndex = 0; passIndex < passCount && !referenceFound; passIndex++) {
            const wordBase = passIndex * 4;
            if (words[wordBase] !== 0 || words[wordBase + 1] !== 0) {
                referenceLow = words[wordBase];
                referenceHigh = words[wordBase + 1];
                referenceFound = true;
            }
        }
        const exclusiveByLabel = this.scratchExclusiveMillisecondsByLabel;
        exclusiveByLabel.fill(0);
        let earliestBeginNanoseconds = Infinity;
        let latestEndNanoseconds = -Infinity;
        let busyNanoseconds = 0;
        let examineQuantization = this.quantizationFramesExamined < quantizationProbeFrameCount;
        let frameGreatestCommonDivisor = this.timestampGreatestCommonDivisorNanoseconds;
        for (let passIndex = 0; passIndex < passCount && referenceFound; passIndex++) {
            const wordBase = passIndex * 4;
            if ((words[wordBase] === 0 && words[wordBase + 1] === 0) || (words[wordBase + 2] === 0 && words[wordBase + 3] === 0)) {
                continue;
            }
            const beginNanoseconds = (words[wordBase + 1] - referenceHigh) * 4294967296 + (words[wordBase] - referenceLow);
            const endNanoseconds = (words[wordBase + 3] - referenceHigh) * 4294967296 + (words[wordBase + 2] - referenceLow);
            if (endNanoseconds < beginNanoseconds) {
                continue;
            }
            const exclusiveStart = beginNanoseconds > latestEndNanoseconds ? beginNanoseconds : latestEndNanoseconds;
            const exclusiveNanoseconds = endNanoseconds > exclusiveStart ? endNanoseconds - exclusiveStart : 0;
            busyNanoseconds += exclusiveNanoseconds;
            exclusiveByLabel[record.labelIndices[passIndex]] += exclusiveNanoseconds / 1e6;
            if (beginNanoseconds < earliestBeginNanoseconds) {
                earliestBeginNanoseconds = beginNanoseconds;
            }
            if (endNanoseconds > latestEndNanoseconds) {
                latestEndNanoseconds = endNanoseconds;
            }
            if (examineQuantization) {
                frameGreatestCommonDivisor = greatestCommonDivisor(frameGreatestCommonDivisor, beginNanoseconds);
                frameGreatestCommonDivisor = greatestCommonDivisor(frameGreatestCommonDivisor, endNanoseconds);
            }
        }
        record.buffer.unmap();
        this.recordsInFlight--;
        this.framesTimed++;
        this.freeRecords.push(record);
        if (latestEndNanoseconds === -Infinity) {
            return;
        }
        if (examineQuantization) {
            this.quantizationFramesExamined++;
            this.timestampGreatestCommonDivisorNanoseconds = frameGreatestCommonDivisor;
        }
        const spanMilliseconds = (latestEndNanoseconds - earliestBeginNanoseconds) / 1e6;
        const busyMilliseconds = busyNanoseconds / 1e6;
        if (record.frameIndex >= this.lastTimedFrameIndex) {
            this.lastTimedFrameIndex = record.frameIndex;
            this.lastSpanMilliseconds = spanMilliseconds;
            this.lastBusyMilliseconds = busyMilliseconds;
            this.lastExclusiveMillisecondsByLabel.set(exclusiveByLabel);
        }
        this.frameLog.recordGpuTiming(record.frameIndex, spanMilliseconds, busyMilliseconds, exclusiveByLabel, this.labelNames.length);
        for (let listenerIndex = 0; listenerIndex < this.timedFrameListeners.length; listenerIndex++) {
            this.timedFrameListeners[listenerIndex](record.frameIndex, spanMilliseconds, busyMilliseconds, exclusiveByLabel);
        }
    }

    addTimedFrameListener(listener) {
        this.timedFrameListeners.push(listener);
    }

    get hasOutstandingReadbacks() {
        return this.recordsInFlight > 0 || this.awaitingMapRecord !== null;
    }

    lastPassMillisecondsObject() {
        const result = {};
        for (let labelIndex = 0; labelIndex < this.labelNames.length; labelIndex++) {
            result[this.labelNames[labelIndex]] = this.lastExclusiveMillisecondsByLabel[labelIndex];
        }
        return result;
    }
}
