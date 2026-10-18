export const fixedCostPassLabels = new Set([
    "historyA",
    "historyB",
    "composite",
    "bloomDown0",
    "bloomDown1",
    "bloomDown2",
    "bloomDown3",
    "bloomUp0",
    "bloomUp1",
    "bloomUp2",
]);

export class ClockGauge {
    constructor({ calibrationFrames = 90, lowestTrustedFraction = 0.6 } = {}) {
        this.calibrationFrames = calibrationFrames;
        this.lowestTrustedFraction = lowestTrustedFraction;
        this.calibrationSamples = [];
        this.referenceMilliseconds = null;
        this.slowdown = 1;
        this.labelIndices = new Int32Array(fixedCostPassLabels.size);
        this.labelIndexCount = 0;
        this.knownLabelCount = 0;
    }

    reset() {
        this.calibrationSamples.length = 0;
        this.referenceMilliseconds = null;
        this.slowdown = 1;
    }

    gaugeMilliseconds(labelNames, exclusiveMillisecondsByLabel) {
        if (labelNames.length !== this.knownLabelCount) {
            this.labelIndexCount = 0;
            labelNames.forEach((labelName, labelIndex) => {
                if (fixedCostPassLabels.has(labelName)) {
                    this.labelIndices[this.labelIndexCount++] = labelIndex;
                }
            });
            this.knownLabelCount = labelNames.length;
        }
        let total = 0;
        for (let index = 0; index < this.labelIndexCount; index++) {
            total += exclusiveMillisecondsByLabel[this.labelIndices[index]];
        }
        return total;
    }

    observe(gaugeMilliseconds) {
        if (!(gaugeMilliseconds > 0)) {
            return this.slowdown;
        }
        if (this.referenceMilliseconds === null) {
            this.calibrationSamples.push(gaugeMilliseconds);
            if (this.calibrationSamples.length >= this.calibrationFrames) {
                this.calibrationSamples.sort((first, second) => first - second);
                this.referenceMilliseconds = this.calibrationSamples[Math.floor(this.calibrationSamples.length * 0.25)];
            }
            this.slowdown = 1;
            return this.slowdown;
        }
        if (gaugeMilliseconds < this.referenceMilliseconds && gaugeMilliseconds > this.referenceMilliseconds * this.lowestTrustedFraction) {
            this.referenceMilliseconds = gaugeMilliseconds;
        }
        this.slowdown = Math.max(1, gaugeMilliseconds / this.referenceMilliseconds);
        return this.slowdown;
    }
}
