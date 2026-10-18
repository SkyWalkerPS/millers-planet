export const audioSettings = {
    masterGain: 0.8,
    seaGain: 0.16,
    roarMaximumGain: 0.95,
    rumbleMaximumGain: 0.5,
    openCutoffHz: 18000,
    muffledCutoffHz: 700,
    splashGain: 0.22,
    bubblesPerSecond: 7,
};

function createNoiseBuffer(context, seconds) {
    const length = Math.floor(context.sampleRate * seconds);
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    let state = 0x9e3779b9;
    for (let index = 0; index < length; index++) {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        data[index] = ((state >>> 0) / 4294967295) * 2 - 1;
    }
    return buffer;
}

export class AudioSystem {
    constructor(settings = {}) {
        this.settings = { ...audioSettings, ...settings };
        this.context = null;
        this.masterGain = null;
        this.muffleCutoffHz = this.settings.openCutoffHz;
        this.underwater = false;
        this.nextBubbleSeconds = 0;
        this.randomState = 0x2545f491;
    }

    random() {
        this.randomState ^= this.randomState << 13;
        this.randomState ^= this.randomState >>> 17;
        this.randomState ^= this.randomState << 5;
        return (this.randomState >>> 0) / 4294967295;
    }

    startOnUserGesture() {
        if (!this.context) {
            const AudioContextClass = window.AudioContext ?? window.webkitAudioContext;
            if (!AudioContextClass) {
                return;
            }
            this.context = new AudioContextClass();
            this.buildGraph();
        }
        if (this.context.state !== "running") {
            this.context.resume();
        }
    }

    buildGraph() {
        const context = this.context;
        const settings = this.settings;
        this.noiseBuffer = createNoiseBuffer(context, 2.5);
        this.masterGain = context.createGain();
        this.masterGain.gain.value = settings.masterGain;
        this.muffle = context.createBiquadFilter();
        this.muffle.type = "lowpass";
        this.muffle.frequency.value = settings.openCutoffHz;
        this.muffle.Q.value = 0.7;
        this.muffle.connect(this.masterGain);
        this.masterGain.connect(context.destination);

        this.seaSource = this.loopingNoise();
        const seaBand = context.createBiquadFilter();
        seaBand.type = "bandpass";
        seaBand.frequency.value = 650;
        seaBand.Q.value = 0.45;
        this.seaGain = context.createGain();
        this.seaGain.gain.value = settings.seaGain;
        const swell = context.createOscillator();
        swell.frequency.value = 0.11;
        const swellDepth = context.createGain();
        swellDepth.gain.value = settings.seaGain * 0.35;
        swell.connect(swellDepth);
        swellDepth.connect(this.seaGain.gain);
        swell.start();
        this.seaSource.connect(seaBand);
        seaBand.connect(this.seaGain);
        this.seaGain.connect(this.muffle);

        this.roarSource = this.loopingNoise();
        this.roarFilter = context.createBiquadFilter();
        this.roarFilter.type = "lowpass";
        this.roarFilter.frequency.value = 90;
        this.roarGain = context.createGain();
        this.roarGain.gain.value = 0;
        this.roarSource.connect(this.roarFilter);
        this.roarFilter.connect(this.roarGain);
        this.roarGain.connect(this.muffle);

        this.rumble = context.createOscillator();
        this.rumble.type = "sine";
        this.rumble.frequency.value = 38;
        this.rumbleGain = context.createGain();
        this.rumbleGain.gain.value = 0;
        this.rumble.connect(this.rumbleGain);
        this.rumbleGain.connect(this.muffle);
        this.rumble.start();

        this.seaSource.start();
        this.roarSource.start();
    }

    loopingNoise() {
        const source = this.context.createBufferSource();
        source.buffer = this.noiseBuffer;
        source.loop = true;
        return source;
    }

    splash(strength) {
        if (!this.context || this.context.state !== "running") {
            return;
        }
        const context = this.context;
        const now = context.currentTime;
        const source = context.createBufferSource();
        source.buffer = this.noiseBuffer;
        const band = context.createBiquadFilter();
        band.type = "bandpass";
        band.frequency.value = 1400 + 900 * this.random();
        band.Q.value = 0.9;
        const gain = context.createGain();
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(this.settings.splashGain * strength, now + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0005, now + 0.22);
        source.connect(band);
        band.connect(gain);
        gain.connect(this.muffle);
        source.start(now, this.random() * 2, 0.25);
    }

    bubble() {
        const context = this.context;
        const now = context.currentTime;
        const oscillator = context.createOscillator();
        oscillator.type = "sine";
        const start = 380 + 500 * this.random();
        oscillator.frequency.setValueAtTime(start, now);
        oscillator.frequency.exponentialRampToValueAtTime(start * 2.6, now + 0.07);
        const gain = context.createGain();
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(0.05 + 0.05 * this.random(), now + 0.006);
        gain.gain.exponentialRampToValueAtTime(0.0005, now + 0.09);
        oscillator.connect(gain);
        gain.connect(this.muffle);
        oscillator.start(now);
        oscillator.stop(now + 0.1);
    }

    update({ approach = 0, underwater = false, splashes = null }) {
        const settings = this.settings;
        this.underwater = underwater;
        this.muffleCutoffHz = underwater ? settings.muffledCutoffHz : settings.openCutoffHz;
        if (!this.context || this.context.state !== "running") {
            return;
        }
        const context = this.context;
        const now = context.currentTime;
        const loudness = approach * approach;
        this.roarGain.gain.setTargetAtTime(settings.roarMaximumGain * loudness, now, 0.4);
        this.roarFilter.frequency.setTargetAtTime(90 + 520 * loudness, now, 0.4);
        this.rumbleGain.gain.setTargetAtTime(settings.rumbleMaximumGain * loudness, now, 0.4);
        this.muffle.frequency.setTargetAtTime(this.muffleCutoffHz, now, 0.08);
        if (splashes) {
            for (const strength of splashes) {
                this.splash(strength);
            }
        }
        if (underwater && now >= this.nextBubbleSeconds) {
            this.bubble();
            this.nextBubbleSeconds = now + (-Math.log(1 - this.random() * 0.999) / settings.bubblesPerSecond);
        }
    }

    get state() {
        return this.context ? this.context.state : "not-started";
    }
}
