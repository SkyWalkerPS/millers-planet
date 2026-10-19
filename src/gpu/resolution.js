const decisionWindowLength = 12;
const modelForgettingFactor = 0.97;
const shortestProbeIntervalFrames = 90;
const longestProbeIntervalFrames = 1200;
const probeStepFraction = 0.025;
const recentSpikeWindowMask = 0b1111;
const singleDeadlineMissCutLimit = 0.15;
const sustainedDeadlineMissCutLimit = 0.3;

function countSetBits(value) {
    let count = 0;
    let remaining = value;
    while (remaining) {
        count += remaining & 1;
        remaining >>>= 1;
    }
    return count;
}

export class DynamicResolutionController {
    constructor({
        minimumScale = 0.5,
        maximumScale = 1.0,
        initialScale = 0.8,
        holdBandLowMilliseconds = 10.5,
        holdBandHighMilliseconds = 11.0,
        singleFrameSpikeMilliseconds = 12.5,
        hardSpikeMilliseconds = 14.0,
        frameDeadlineGuardMilliseconds = 16.0,
        rawStepUpCeilingMilliseconds = 15.5,
        assumedFixedCostFraction = 0.45,
    } = {}) {
        this.minimumScale = minimumScale;
        this.maximumScale = maximumScale;
        this.holdBandLowMilliseconds = holdBandLowMilliseconds;
        this.holdBandHighMilliseconds = holdBandHighMilliseconds;
        this.targetMilliseconds = (holdBandLowMilliseconds + holdBandHighMilliseconds) * 0.5;
        this.singleFrameSpikeMilliseconds = singleFrameSpikeMilliseconds;
        this.hardSpikeMilliseconds = hardSpikeMilliseconds;
        this.frameDeadlineGuardMilliseconds = frameDeadlineGuardMilliseconds;
        this.rawStepUpCeilingMilliseconds = rawStepUpCeilingMilliseconds;
        this.windowRawMaximumMilliseconds = 0;
        this.stepUpsBlockedByRawSpan = 0;
        this.deadlineCutCount = 0;
        this.previousFrameMissedDeadline = false;
        this.lastClockSlowdown = 1;
        this.lastNormalizedSpanMilliseconds = 0;
        this.recentSpikeFlags = 0;
        this.probeIntervalFrames = shortestProbeIntervalFrames;
        this.lastScaleChangeFrameIndex = 0;
        this.probeCount = 0;
        this.assumedFixedCostFraction = assumedFixedCostFraction;
        this.scale = initialScale;
        this.pinnedScale = null;
        this.windowSpans = new Float64Array(decisionWindowLength);
        this.sortedWindowSpans = new Float64Array(decisionWindowLength);
        this.windowCount = 0;
        this.scaleChangeFrameIndex = 0;
        this.latestSubmittedFrameIndex = 0;
        this.weightSum = 0;
        this.weightedX = 0;
        this.weightedY = 0;
        this.weightedXX = 0;
        this.weightedXY = 0;
        this.decisionCount = 0;
        this.stepUpCount = 0;
        this.stepDownCount = 0;
        this.spikeCutCount = 0;
        this.preemptiveCutCount = 0;
        this.lastDecisionReason = "start";
    }

    setLimits({ minimumScale = this.minimumScale, maximumScale = this.maximumScale } = {}) {
        this.minimumScale = minimumScale;
        this.maximumScale = maximumScale;
        this.applyScale(this.scale, "limits");
    }

    pin(scaleOrNull) {
        this.pinnedScale = scaleOrNull === null ? null : Math.min(this.maximumScale, Math.max(0.1, scaleOrNull));
        if (this.pinnedScale !== null) {
            this.applyScale(this.pinnedScale, "pinned");
        }
    }

    get currentScale() {
        return this.pinnedScale ?? this.scale;
    }

    noteFrameSubmitted(frameIndex) {
        this.latestSubmittedFrameIndex = frameIndex;
    }

    applyScale(newScale, reason) {
        const clamped = Math.min(this.maximumScale, Math.max(this.minimumScale, newScale));
        if (this.pinnedScale === null && Math.abs(clamped - this.scale) < 1e-4) {
            return;
        }
        this.scale = this.pinnedScale ?? clamped;
        this.windowCount = 0;
        this.windowRawMaximumMilliseconds = 0;
        this.recentSpikeFlags = 0;
        this.scaleChangeFrameIndex = this.latestSubmittedFrameIndex + 1;
        this.lastScaleChangeFrameIndex = this.latestSubmittedFrameIndex;
        this.lastDecisionReason = reason;
        this.decisionCount++;
    }

    requestPreemptiveCut(fraction = 0.05, reason = "preemptive", largestFraction = 0.2) {
        if (this.pinnedScale !== null) {
            return;
        }
        this.preemptiveCutCount++;
        this.applyScale(this.scale * (1 - Math.min(largestFraction, Math.max(0, fraction))), reason);
    }

    updateCostModel(scaleOfFrame, spanMilliseconds) {
        const x = scaleOfFrame * scaleOfFrame;
        this.weightSum = this.weightSum * modelForgettingFactor + 1;
        this.weightedX = this.weightedX * modelForgettingFactor + x;
        this.weightedY = this.weightedY * modelForgettingFactor + spanMilliseconds;
        this.weightedXX = this.weightedXX * modelForgettingFactor + x * x;
        this.weightedXY = this.weightedXY * modelForgettingFactor + x * spanMilliseconds;
    }

    modelledScaleForTarget(currentSpanMilliseconds) {
        const determinant = this.weightSum * this.weightedXX - this.weightedX * this.weightedX;
        let fixedMilliseconds;
        let scalableMillisecondsAtFullScale;
        const meanX = this.weightSum > 0 ? this.weightedX / this.weightSum : 0;
        const varianceX = this.weightSum > 0 ? this.weightedXX / this.weightSum - meanX * meanX : 0;
        if (determinant > 1e-9 && varianceX > 0.0016) {
            scalableMillisecondsAtFullScale = (this.weightSum * this.weightedXY - this.weightedX * this.weightedY) / determinant;
            fixedMilliseconds = (this.weightedY - scalableMillisecondsAtFullScale * this.weightedX) / this.weightSum;
        } else {
            fixedMilliseconds = currentSpanMilliseconds * this.assumedFixedCostFraction;
            scalableMillisecondsAtFullScale = (currentSpanMilliseconds - fixedMilliseconds) / (this.scale * this.scale);
        }
        if (!(scalableMillisecondsAtFullScale > 0.05) || fixedMilliseconds < 0) {
            fixedMilliseconds = currentSpanMilliseconds * this.assumedFixedCostFraction;
            scalableMillisecondsAtFullScale = (currentSpanMilliseconds - fixedMilliseconds) / (this.scale * this.scale);
        }
        const available = this.targetMilliseconds - fixedMilliseconds;
        if (available <= 0) {
            return this.minimumScale;
        }
        return Math.sqrt(available / scalableMillisecondsAtFullScale);
    }

    windowMedian() {
        const count = this.windowCount;
        for (let sampleIndex = 0; sampleIndex < count; sampleIndex++) {
            const value = this.windowSpans[sampleIndex];
            let insertAt = sampleIndex;
            while (insertAt > 0 && this.sortedWindowSpans[insertAt - 1] > value) {
                this.sortedWindowSpans[insertAt] = this.sortedWindowSpans[insertAt - 1];
                insertAt--;
            }
            this.sortedWindowSpans[insertAt] = value;
        }
        return this.sortedWindowSpans[count >> 1];
    }

    onFrameTimed(frameIndex, rawSpanMilliseconds, scaleOfFrame, clockSlowdown = 1) {
        if (!(rawSpanMilliseconds > 0)) {
            return;
        }
        const slowdown = Math.max(clockSlowdown, 1);
        const spanMilliseconds = rawSpanMilliseconds / slowdown;
        this.lastClockSlowdown = slowdown;
        this.lastNormalizedSpanMilliseconds = spanMilliseconds;
        this.updateCostModel(scaleOfFrame, spanMilliseconds);
        if (this.pinnedScale !== null) {
            return;
        }
        const frameWasDrawnAtOrBelowCurrentScale = scaleOfFrame <= this.scale + 1e-6;
        const frameMissedDeadline = rawSpanMilliseconds > this.frameDeadlineGuardMilliseconds;
        const missStreak = frameMissedDeadline && this.previousFrameMissedDeadline;
        this.previousFrameMissedDeadline = frameMissedDeadline;
        if (frameMissedDeadline) {
            const areaRatioToCurrentScale = (this.scale / scaleOfFrame) ** 2;
            const expectedRawAtCurrentScale = rawSpanMilliseconds * Math.min(1, areaRatioToCurrentScale);
            if (frameWasDrawnAtOrBelowCurrentScale || (missStreak && expectedRawAtCurrentScale > this.frameDeadlineGuardMilliseconds)) {
                const largestCut = missStreak ? sustainedDeadlineMissCutLimit : singleDeadlineMissCutLimit;
                const cutFraction = Math.min(largestCut, Math.max(0.05, 1 - Math.sqrt(this.frameDeadlineGuardMilliseconds * 0.85 / expectedRawAtCurrentScale)));
                this.deadlineCutCount++;
                this.stepDownCount++;
                this.probeIntervalFrames = Math.min(longestProbeIntervalFrames, this.probeIntervalFrames * 2);
                this.applyScale(this.scale * (1 - cutFraction), missStreak ? "deadline streak" : "deadline");
                return;
            }
        }
        if (frameIndex < this.scaleChangeFrameIndex) {
            return;
        }
        this.windowRawMaximumMilliseconds = Math.max(this.windowRawMaximumMilliseconds, rawSpanMilliseconds);
        this.recentSpikeFlags = ((this.recentSpikeFlags << 1) | (spanMilliseconds > this.singleFrameSpikeMilliseconds ? 1 : 0)) & recentSpikeWindowMask;
        if (spanMilliseconds > this.hardSpikeMilliseconds || countSetBits(this.recentSpikeFlags) >= 2) {
            const cutFraction = Math.min(0.15, Math.max(0.05, 1 - Math.sqrt(this.targetMilliseconds / spanMilliseconds)));
            this.spikeCutCount++;
            this.stepDownCount++;
            this.probeIntervalFrames = Math.min(longestProbeIntervalFrames, this.probeIntervalFrames * 2);
            this.applyScale(this.scale * (1 - cutFraction), "spike");
            return;
        }
        this.windowSpans[this.windowCount++] = spanMilliseconds;
        if (this.windowCount < decisionWindowLength) {
            return;
        }
        const medianSpan = this.windowMedian();
        const rawSpanLeftRoomToStepUp = this.windowRawMaximumMilliseconds < this.rawStepUpCeilingMilliseconds;
        this.windowCount = 0;
        this.windowRawMaximumMilliseconds = 0;
        const wantsToStepUp = this.scale < this.maximumScale && (medianSpan < this.holdBandLowMilliseconds || frameIndex - this.lastScaleChangeFrameIndex >= this.probeIntervalFrames);
        if (medianSpan <= this.holdBandHighMilliseconds && wantsToStepUp && !rawSpanLeftRoomToStepUp) {
            this.stepUpsBlockedByRawSpan++;
            return;
        }
        if (medianSpan > this.holdBandHighMilliseconds) {
            const modelled = this.modelledScaleForTarget(medianSpan);
            const proposed = Math.min(this.scale * 0.985, Math.max(modelled, this.scale * 0.93));
            this.stepDownCount++;
            this.probeIntervalFrames = Math.min(longestProbeIntervalFrames, this.probeIntervalFrames * 2);
            this.applyScale(proposed, "over budget");
        } else if (medianSpan < this.holdBandLowMilliseconds && this.scale < this.maximumScale) {
            const headroom = (this.targetMilliseconds - medianSpan) / this.targetMilliseconds;
            const step = Math.min(0.04, Math.max(0.015, headroom * 0.5));
            this.stepUpCount++;
            this.probeIntervalFrames = shortestProbeIntervalFrames;
            this.applyScale(this.scale * (1 + step), "headroom");
        } else if (this.scale < this.maximumScale && frameIndex - this.lastScaleChangeFrameIndex >= this.probeIntervalFrames) {
            this.probeCount++;
            this.stepUpCount++;
            this.applyScale(this.scale * (1 + probeStepFraction), "probe");
        }
    }

    internalSize(outputWidth, outputHeight, target) {
        const scale = this.currentScale;
        target[0] = Math.max(16, Math.round(outputWidth * scale));
        target[1] = Math.max(16, Math.round(outputHeight * scale));
        return target;
    }
}
