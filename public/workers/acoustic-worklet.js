/**
 * AudioWorkletProcessor for Acoustic Frequency Spectra (1024-point FFT)
 *
 * Runs the WebAssembly noise spectrum engine in the audio worklet thread,
 * computing FFTs completely off the main thread.
 *
 * Provides a pure JS/TS fallback if WASM or SIMD is not supported.
 */

class AcousticWorkletProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.wasmReady = false;
    this.wasmExports = null;
    this.realPtr = 0;
    this.octavePtr = 0;

    this.fftSize = 1024;
    this.buffer = new Float32Array(this.fftSize);
    this.bufferIndex = 0;

    // Optional: downsample or send messages at 30Hz
    // We get 128 samples per process() call.
    // 48000 Hz / 128 = 375 calls per second.
    // 375 / 30 Hz ~ 12.5 calls. We'll wait until we collect `fftSize` samples (1024 / 128 = 8 calls)

    this.port.onmessage = this.handleMessage.bind(this);

    // JS Fallback structures
    this.cosTable = new Float32Array(this.fftSize / 2);
    this.sinTable = new Float32Array(this.fftSize / 2);
    this.bitReverseTable = new Int32Array(this.fftSize);
    this.windowTable = new Float32Array(this.fftSize);
    this.initJSFallback();
  }

  initJSFallback() {
    for (let i = 0; i < this.fftSize / 2; i++) {
        const angle = -2.0 * Math.PI * i / this.fftSize;
        this.cosTable[i] = Math.cos(angle);
        this.sinTable[i] = Math.sin(angle);
    }
    const bits = Math.log2(this.fftSize);
    for (let i = 0; i < this.fftSize; i++) {
        let r = 0;
        let val = i;
        for (let j = 0; j < bits; j++) {
            r = (r << 1) | (val & 1);
            val >>= 1;
        }
        this.bitReverseTable[i] = r;
    }
    for (let i = 0; i < this.fftSize; i++) {
        this.windowTable[i] = 0.5 * (1.0 - Math.cos(2.0 * Math.PI * i / (this.fftSize - 1)));
    }
  }

  computeFFTJS(input) {
    const real = new Float32Array(this.fftSize);
    const imag = new Float32Array(this.fftSize);

    for (let i = 0; i < this.fftSize; i++) {
        real[this.bitReverseTable[i]] = input[i] * this.windowTable[i];
    }

    for (let step = 2, halfStep = 1; step <= this.fftSize; step <<= 1, halfStep <<= 1) {
        const twiddleStep = this.fftSize / step;
        for (let i = 0; i < this.fftSize; i += step) {
            for (let j = 0; j < halfStep; j++) {
                const twiddleIdx = j * twiddleStep;
                const wr = this.cosTable[twiddleIdx];
                const wi = this.sinTable[twiddleIdx];

                const evenIdx = i + j;
                const oddIdx = i + j + halfStep;

                const er = real[evenIdx];
                const ei = imag[evenIdx];

                const or_ = real[oddIdx];
                const oi = imag[oddIdx];

                const tr = wr * or_ - wi * oi;
                const ti = wr * oi + wi * or_;

                real[evenIdx] = er + tr;
                imag[evenIdx] = ei + ti;

                real[oddIdx] = er - tr;
                imag[oddIdx] = ei - ti;
            }
        }
    }

    const numBins = this.fftSize / 2 + 1;
    const magnitudes = new Float32Array(numBins);
    for (let i = 0; i < numBins; i++) {
        magnitudes[i] = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]);
    }

    // Octave bands (31 bands)
    const octaveBands = new Float32Array(31);
    const binWidth = 48000.0 / this.fftSize;
    for (let bin = 1; bin < numBins; bin++) {
        const freq = bin * binWidth;
        let band = -1;
        let center = 20.0;
        for (let k = 0; k < 31; k++) {
            const lower = center * Math.pow(2.0, -1.0/6.0);
            const upper = center * Math.pow(2.0, 1.0/6.0);
            if (freq >= lower && freq < upper) {
                band = k;
                break;
            } else if (k === 30 && freq >= upper) {
                band = 30;
                break;
            }
            center = center * Math.pow(2.0, 1.0/3.0);
        }
        if (band >= 0) {
            octaveBands[band] += magnitudes[bin];
        }
    }

    // Also compute RMS for overall decibel
    let sumSq = 0;
    for (let i = 0; i < this.fftSize; i++) {
        sumSq += input[i] * input[i];
    }
    const rms = Math.sqrt(sumSq / this.fftSize);

    return { rms, octaveBands };
}

  static async probeSIMDSupport() {
    try {
      const testBytes = new Uint8Array([
        0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x05, 0x01, 0x60,
        0x00, 0x01, 0x7b, 0x03, 0x02, 0x01, 0x00, 0x07, 0x08, 0x01, 0x04, 0x74,
        0x65, 0x73, 0x74, 0x00, 0x00, 0x0a, 0x16, 0x01, 0x14, 0x00, 0xfd, 0x0c,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x0b,
      ]);
      const mod = await WebAssembly.compile(testBytes);
      const inst = await WebAssembly.instantiate(mod);
      inst.exports.test();
      return true;
    } catch {
      return false;
    }
  }

  async handleMessage(event) {
    const { type, wasmBinary } = event.data;

    if (type === "init") {
      try {
        const simdAvailable = await AcousticWorkletProcessor.probeSIMDSupport();
        if (!simdAvailable) {
            console.warn("[AcousticWorklet] WASM SIMD not supported, using pure JS fallback.");
            this.port.postMessage({ type: "ready", usingWasm: false });
            return;
        }

        const wasmModule = await WebAssembly.compile(wasmBinary);
        const instance = await WebAssembly.instantiate(wasmModule);
        this.wasmExports = instance.exports;

        this.wasmExports.init_fft();
        this.realPtr = this.wasmExports.get_real_ptr();
        this.octavePtr = this.wasmExports.get_octave_bands_ptr();

        this.wasmReady = true;
        this.port.postMessage({ type: "ready", usingWasm: true });
      } catch (err) {
        console.warn("[AcousticWorklet] WASM init failed, using pure JS fallback.", err);
        this.port.postMessage({ type: "ready", usingWasm: false });
      }
    }
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (!input || !input.length || !input[0]) return true;

    const channelData = input[0];

    // Fill the 1024 buffer
    for (let i = 0; i < channelData.length; i++) {
        this.buffer[this.bufferIndex++] = channelData[i];

        if (this.bufferIndex >= this.fftSize) {
            this.computeAndSend();
            this.bufferIndex = 0;
            // Overlapping frames could be implemented here by shifting the buffer,
            // but for simplicity and CPU, we'll do non-overlapping or zero out.
        }
    }

    return true;
  }

  computeAndSend() {
    let rms = 0;

    if (this.wasmReady) {
        const realView = new Float32Array(this.wasmExports.memory.buffer, this.realPtr, this.fftSize);
        realView.set(this.buffer);

        rms = this.wasmExports.calculate_rms();

        this.wasmExports.compute_fft_simd();
        this.wasmExports.compute_octave_bands();

        // Return 1/3 octave band energy summaries
        const octaveView = new Float32Array(this.wasmExports.memory.buffer, this.octavePtr, 31);
        const octaveBands = Array.from(octaveView); // Copy so we can send

        this.port.postMessage({ type: "spectrum", rms, octaveBands });
    } else {
        const result = this.computeFFTJS(this.buffer);
        // Also copy the fallback bands
        const octaveBands = Array.from(result.octaveBands);
        this.port.postMessage({ type: "spectrum", rms: result.rms, octaveBands });
    }
  }
}

registerProcessor("acoustic-worklet", AcousticWorkletProcessor);
