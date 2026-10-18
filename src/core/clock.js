const largestSimulationStepSeconds = 0.1;

export class SimulationClock {
    constructor() {
        this.timeSeconds = 0;
        this.frozenAtSeconds = null;
        this.lastDeltaSeconds = 1 / 60;
        this.started = false;
    }

    advance(deltaSeconds) {
        const clampedDelta = Math.min(Math.max(deltaSeconds, 0), largestSimulationStepSeconds);
        this.lastDeltaSeconds = this.frozenAtSeconds === null ? clampedDelta : 0;
        if (this.frozenAtSeconds === null) {
            if (this.started) {
                this.timeSeconds += clampedDelta;
            }
            this.started = true;
        } else {
            this.timeSeconds = this.frozenAtSeconds;
        }
    }

    freeze(secondsOrNull) {
        this.frozenAtSeconds = secondsOrNull;
        if (secondsOrNull !== null) {
            this.timeSeconds = secondsOrNull;
        }
    }

    jumpTo(seconds) {
        this.timeSeconds = seconds;
        if (this.frozenAtSeconds !== null) {
            this.frozenAtSeconds = seconds;
        }
    }

    get isFrozen() {
        return this.frozenAtSeconds !== null;
    }
}
