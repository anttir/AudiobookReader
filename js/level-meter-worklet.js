/**
 * AudioWorklet for AudioDiagnostics: level (dBFS) of each render quantum
 * (128 frames) of its input, posted to the main thread in batches.
 * null = no input connected.
 */
class LevelMeter extends AudioWorkletProcessor {
    constructor() {
        super();
        this.levels = [];
    }

    process(inputs) {
        const channels = inputs[0];
        let db = null;
        if (channels && channels.length) {
            let sum = 0, n = 0;
            for (const ch of channels) {
                for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
                n += ch.length;
            }
            db = sum > 0 ? 10 * Math.log10(sum / n) : -200;
        }
        this.levels.push(db);
        if (this.levels.length >= 32) {
            this.port.postMessage(this.levels);
            this.levels = [];
        }
        return true;
    }
}

registerProcessor('level-meter', LevelMeter);
