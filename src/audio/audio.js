export class AudioSystem {
    constructor() {
        this.context = null;
        this.masterGain = null;
        this.muffleCutoffHz = 20000;
    }

    startOnUserGesture() {
        if (!this.context) {
            const AudioContextClass = window.AudioContext ?? window.webkitAudioContext;
            if (!AudioContextClass) {
                return;
            }
            this.context = new AudioContextClass();
            this.masterGain = this.context.createGain();
            this.masterGain.gain.value = 0.8;
            this.masterGain.connect(this.context.destination);
        }
        if (this.context.state !== "running") {
            this.context.resume();
        }
    }

    get state() {
        return this.context ? this.context.state : "not-started";
    }
}
