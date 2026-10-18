const recentTickHistoryLength = 16;

export function createFramePacer({ targetIntervalMilliseconds = 1000 / 60 } = {}) {
    const recentTickIntervals = new Float64Array(recentTickHistoryLength);
    const sortedTickIntervals = new Float64Array(recentTickHistoryLength);
    let recordedTickCount = 0;
    let previousRafTimeMilliseconds = -1;
    let nextDueTimeMilliseconds = -1;

    function medianTickIntervalMilliseconds() {
        const sampleCount = Math.min(recordedTickCount, recentTickHistoryLength);
        if (sampleCount === 0) {
            return 0;
        }
        if (sampleCount < 4) {
            return recentTickIntervals[(recordedTickCount - 1) % recentTickHistoryLength];
        }
        for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
            const value = recentTickIntervals[sampleIndex];
            let insertAt = sampleIndex;
            while (insertAt > 0 && sortedTickIntervals[insertAt - 1] > value) {
                sortedTickIntervals[insertAt] = sortedTickIntervals[insertAt - 1];
                insertAt--;
            }
            sortedTickIntervals[insertAt] = value;
        }
        return sortedTickIntervals[sampleCount >> 1];
    }

    function shouldRender(rafTimeMilliseconds) {
        if (previousRafTimeMilliseconds >= 0) {
            const tickInterval = rafTimeMilliseconds - previousRafTimeMilliseconds;
            if (tickInterval > 0 && tickInterval < 250) {
                recentTickIntervals[recordedTickCount % recentTickHistoryLength] = tickInterval;
                recordedTickCount++;
            }
        }
        previousRafTimeMilliseconds = rafTimeMilliseconds;
        if (nextDueTimeMilliseconds < 0) {
            nextDueTimeMilliseconds = rafTimeMilliseconds + targetIntervalMilliseconds;
            return true;
        }
        const halfTick = medianTickIntervalMilliseconds() * 0.5;
        if (rafTimeMilliseconds + halfTick < nextDueTimeMilliseconds) {
            return false;
        }
        nextDueTimeMilliseconds += targetIntervalMilliseconds;
        if (nextDueTimeMilliseconds < rafTimeMilliseconds - targetIntervalMilliseconds) {
            nextDueTimeMilliseconds = rafTimeMilliseconds + targetIntervalMilliseconds;
        }
        return true;
    }

    function reset() {
        recordedTickCount = 0;
        previousRafTimeMilliseconds = -1;
        nextDueTimeMilliseconds = -1;
    }

    return { shouldRender, reset };
}
