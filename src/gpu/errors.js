const maximumRememberedErrors = 64;

export class GpuErrorCollector {
    constructor(device) {
        this.messages = [];
        this.totalErrorCount = 0;
        this.deviceLost = false;
        this.deviceLostReason = "";
        device.addEventListener("uncapturederror", (event) => {
            this.totalErrorCount++;
            if (this.messages.length < maximumRememberedErrors) {
                this.messages.push(String(event.error?.message ?? event.error ?? "unknown WebGPU error"));
            }
        });
        device.lost.then((information) => {
            this.deviceLost = true;
            this.deviceLostReason = `${information.reason}: ${information.message}`;
        });
    }

    clear() {
        this.messages.length = 0;
        this.totalErrorCount = 0;
    }
}
