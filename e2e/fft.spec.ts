import { test, expect } from '@playwright/test';
import fs from 'fs';

test('WASM FFT Benchmark and 1/3 Octave Bands Correctness', async ({ page }) => {
    await page.goto('about:blank');

    const wasmBuffer = fs.readFileSync('public/workers/fft-processor.wasm');
    const wasmBase64 = wasmBuffer.toString('base64');

    // Inject benchmark script
    const result = await page.evaluate(async (base64) => {
        const testBytes = new Uint8Array([
            0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x05, 0x01, 0x60,
            0x00, 0x01, 0x7b, 0x03, 0x02, 0x01, 0x00, 0x07, 0x08, 0x01, 0x04, 0x74,
            0x65, 0x73, 0x74, 0x00, 0x00, 0x0a, 0x16, 0x01, 0x14, 0x00, 0xfd, 0x0c,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x0b,
        ]);
        let simd = false;
        try {
            const mod = await WebAssembly.compile(testBytes);
            const inst = await WebAssembly.instantiate(mod);
            // @ts-ignore
            inst.exports.test();
            simd = true;
        } catch {
            simd = false;
        }

        if (!simd) return { error: "SIMD not supported in browser context" };

        const binaryString = atob(base64);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }

        const wasmModule = await WebAssembly.compile(bytes.buffer);
        const instance = await WebAssembly.instantiate(wasmModule);
        const wasmExports = instance.exports;

        // @ts-ignore
        wasmExports.init_fft();
        // @ts-ignore
        const realPtr = wasmExports.get_real_ptr();
        // @ts-ignore
        const octavePtr = wasmExports.get_octave_bands_ptr();

        const fftSize = 1024;
        const realView = new Float32Array(wasmExports.memory.buffer, realPtr, fftSize);

        // Populate dummy sine wave, 1000 Hz tone.
        // bin = freq * 1024 / 48000
        // freq = 1000 => bin = 21.33 => round to 21
        for(let i=0; i<fftSize; i++) {
            realView[i] = Math.sin(2 * Math.PI * 21 * i / fftSize);
        }

        const start = performance.now();
        const iters = 1000;
        for(let i=0; i<iters; i++) {
            // @ts-ignore
            wasmExports.compute_fft_simd();
            // @ts-ignore
            wasmExports.compute_octave_bands();
        }
        const end = performance.now();

        const avgMs = (end - start) / iters;

        const octaveView = new Float32Array(wasmExports.memory.buffer, octavePtr, 31);
        const octaveBands = Array.from(octaveView);

        return { avgMs, simd, octaveBands };
    }, wasmBase64);

    if (result.error) {
        console.log("SIMD unsupported in playwright context, skipping threshold check");
    } else {
        console.log(`WASM FFT benchmark: ${result.avgMs} ms per 1024-point frame`);
        expect(result.avgMs).toBeLessThan(0.8);

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
    }
});
