import { test, expect } from '@jest/globals';

function computeFFTJS(input: Float32Array, fftSize: number) {
    const cosTable = new Float32Array(fftSize / 2);
    const sinTable = new Float32Array(fftSize / 2);
    const bitReverseTable = new Int32Array(fftSize);
    const windowTable = new Float32Array(fftSize);

    for (let i = 0; i < fftSize / 2; i++) {
        const angle = -2.0 * Math.PI * i / fftSize;
        cosTable[i] = Math.cos(angle);
        sinTable[i] = Math.sin(angle);
    }
    const bits = Math.log2(fftSize);
    for (let i = 0; i < fftSize; i++) {
        let r = 0;
        let val = i;
        for (let j = 0; j < bits; j++) {
            r = (r << 1) | (val & 1);
            val >>= 1;
        }
        bitReverseTable[i] = r;
    }
    for (let i = 0; i < fftSize; i++) {
        windowTable[i] = 0.5 * (1.0 - Math.cos(2.0 * Math.PI * i / (fftSize - 1)));
    }

    const real = new Float32Array(fftSize);
    const imag = new Float32Array(fftSize);

    for (let i = 0; i < fftSize; i++) {
        real[bitReverseTable[i]] = input[i] * windowTable[i];
    }

    for (let step = 2, halfStep = 1; step <= fftSize; step <<= 1, halfStep <<= 1) {
        const twiddleStep = fftSize / step;
        for (let i = 0; i < fftSize; i += step) {
            for (let j = 0; j < halfStep; j++) {
                const twiddleIdx = j * twiddleStep;
                const wr = cosTable[twiddleIdx];
                const wi = sinTable[twiddleIdx];

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

    const numBins = fftSize / 2 + 1;
    const magnitudes = new Float32Array(numBins);
    for (let i = 0; i < numBins; i++) {
        magnitudes[i] = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]);
    }

    const octaveBands = new Float32Array(31);
    const binWidth = 48000.0 / fftSize;
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

    let sumSq = 0;
    for (let i = 0; i < fftSize; i++) {
        sumSq += input[i] * input[i];
    }
    const rms = Math.sqrt(sumSq / fftSize);

    return { rms, octaveBands };
}

test('JS Fallback FFT generates accurate RMS and magnitudes', () => {
    const fftSize = 1024;
    const input = new Float32Array(fftSize);

    const bin = 21; // ~1000Hz
    for (let i = 0; i < fftSize; i++) {
        input[i] = Math.sin(2 * Math.PI * bin * i / fftSize);
    }

    const result = computeFFTJS(input, fftSize);

    expect(result.rms).toBeCloseTo(0.707, 2);

    let maxBandIdx = -1;
    let maxBandVal = -1;
    for(let i=0; i<31; i++) {
        if(result.octaveBands[i] > maxBandVal) {
            maxBandVal = result.octaveBands[i];
            maxBandIdx = i;
        }
    }
    expect(maxBandIdx).toBeGreaterThanOrEqual(16);
    expect(maxBandIdx).toBeLessThanOrEqual(18);
});
