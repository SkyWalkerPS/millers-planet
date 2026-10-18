export const frameLogCapacity = 4096;
export const maximumProfiledLabelCount = 48;

export class FrameLog {
    constructor() {
        this.frameIndexBySlot = new Int32Array(frameLogCapacity).fill(-1);
        this.rafTimeMillisecondsBySlot = new Float64Array(frameLogCapacity);
        this.gpuSpanMillisecondsBySlot = new Float32Array(frameLogCapacity);
        this.gpuBusyMillisecondsBySlot = new Float32Array(frameLogCapacity);
        this.passMillisecondsBySlotAndLabel = new Float32Array(frameLogCapacity * maximumProfiledLabelCount);
        this.renderScaleBySlot = new Float32Array(frameLogCapacity);
        this.renderTargetGenerationBySlot = new Int32Array(frameLogCapacity);
        this.wavePhaseCodeBySlot = new Int32Array(frameLogCapacity);
        this.cameraModeCodeBySlot = new Int32Array(frameLogCapacity);
        this.timedBySlot = new Uint8Array(frameLogCapacity);
        this.latestFrameIndex = -1;
    }

    recordSubmittedFrame(frameIndex, rafTimeMilliseconds, renderScale, renderTargetGeneration, wavePhaseCode, cameraModeCode) {
        const slot = frameIndex % frameLogCapacity;
        this.frameIndexBySlot[slot] = frameIndex;
        this.rafTimeMillisecondsBySlot[slot] = rafTimeMilliseconds;
        this.renderScaleBySlot[slot] = renderScale;
        this.renderTargetGenerationBySlot[slot] = renderTargetGeneration;
        this.wavePhaseCodeBySlot[slot] = wavePhaseCode;
        this.cameraModeCodeBySlot[slot] = cameraModeCode;
        this.timedBySlot[slot] = 0;
        this.gpuSpanMillisecondsBySlot[slot] = 0;
        this.gpuBusyMillisecondsBySlot[slot] = 0;
        this.passMillisecondsBySlotAndLabel.fill(0, slot * maximumProfiledLabelCount, (slot + 1) * maximumProfiledLabelCount);
        if (frameIndex > this.latestFrameIndex) {
            this.latestFrameIndex = frameIndex;
        }
    }

    recordGpuTiming(frameIndex, spanMilliseconds, busyMilliseconds, exclusiveMillisecondsByLabel, labelCount) {
        const slot = frameIndex % frameLogCapacity;
        if (this.frameIndexBySlot[slot] !== frameIndex) {
            return;
        }
        this.gpuSpanMillisecondsBySlot[slot] = spanMilliseconds;
        this.gpuBusyMillisecondsBySlot[slot] = busyMilliseconds;
        const labelBase = slot * maximumProfiledLabelCount;
        for (let labelIndex = 0; labelIndex < labelCount; labelIndex++) {
            this.passMillisecondsBySlotAndLabel[labelBase + labelIndex] = exclusiveMillisecondsByLabel[labelIndex];
        }
        this.timedBySlot[slot] = 1;
    }

    exportSince(sinceFrameIndex, labelNames) {
        const firstFrameIndex = Math.max(sinceFrameIndex + 1, this.latestFrameIndex - frameLogCapacity + 1, 0);
        const exported = {
            labelNames: labelNames.slice(),
            frameIndex: [],
            rafTimeMs: [],
            gpuSpanMs: [],
            gpuBusyMs: [],
            passMs: [],
            scale: [],
            generation: [],
            wavePhaseCode: [],
            cameraModeCode: [],
            untimedFrames: 0,
            latestFrameIndex: this.latestFrameIndex,
        };
        for (let frameIndex = firstFrameIndex; frameIndex <= this.latestFrameIndex; frameIndex++) {
            const slot = frameIndex % frameLogCapacity;
            if (this.frameIndexBySlot[slot] !== frameIndex) {
                continue;
            }
            if (!this.timedBySlot[slot]) {
                exported.untimedFrames++;
                continue;
            }
            exported.frameIndex.push(frameIndex);
            exported.rafTimeMs.push(this.rafTimeMillisecondsBySlot[slot]);
            exported.gpuSpanMs.push(this.gpuSpanMillisecondsBySlot[slot]);
            exported.gpuBusyMs.push(this.gpuBusyMillisecondsBySlot[slot]);
            const passRow = [];
            const labelBase = slot * maximumProfiledLabelCount;
            for (let labelIndex = 0; labelIndex < labelNames.length; labelIndex++) {
                passRow.push(this.passMillisecondsBySlotAndLabel[labelBase + labelIndex]);
            }
            exported.passMs.push(passRow);
            exported.scale.push(this.renderScaleBySlot[slot]);
            exported.generation.push(this.renderTargetGenerationBySlot[slot]);
            exported.wavePhaseCode.push(this.wavePhaseCodeBySlot[slot]);
            exported.cameraModeCode.push(this.cameraModeCodeBySlot[slot]);
        }
        return exported;
    }
}
