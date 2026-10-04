#include <cmath>
#include <cstring>
#include <wasm_simd128.h>

#define FFT_SIZE 1024
#define HALF_FFT (FFT_SIZE / 2)
#define NUM_BINS (HALF_FFT + 1)
#define NUM_OCTAVE_BANDS 31

// Precomputed twiddle factors
alignas(16) static float cos_table[HALF_FFT];
alignas(16) static float sin_table[HALF_FFT];

// Bit reversal table
static int bit_reverse_table[FFT_SIZE];

static bool initialized = false;

alignas(16) static float real_buf[FFT_SIZE];
alignas(16) static float imag_buf[FFT_SIZE];
alignas(16) static float window_buf[FFT_SIZE];

// The output bands to send to JS
alignas(16) static float octave_bands[NUM_OCTAVE_BANDS];

extern "C" {

void init_fft() {
    if (initialized) return;

    for (int i = 0; i < HALF_FFT; i++) {
        float angle = -2.0f * M_PI * (float)i / (float)FFT_SIZE;
        cos_table[i] = cosf(angle);
        sin_table[i] = sinf(angle);
    }

    int bits = 10; // log2(1024)
    for (int i = 0; i < FFT_SIZE; i++) {
        int r = 0;
        int val = i;
        for (int j = 0; j < bits; j++) {
            r = (r << 1) | (val & 1);
            val >>= 1;
        }
        bit_reverse_table[i] = r;
    }

    // Hann window
    for (int i = 0; i < FFT_SIZE; i++) {
        window_buf[i] = 0.5f * (1.0f - cosf(2.0f * M_PI * (float)i / (float)(FFT_SIZE - 1)));
    }

    initialized = true;
}

float* get_real_ptr() {
    return real_buf;
}

float* get_octave_bands_ptr() {
    return octave_bands;
}

// SIMD optimized FFT (radix-2, only vectorizing inner loops where possible)
void compute_fft_simd() {
    // Bit reversal and windowing
    alignas(16) float temp_real[FFT_SIZE];
    for (int i = 0; i < FFT_SIZE; i++) {
        temp_real[bit_reverse_table[i]] = real_buf[i] * window_buf[i];
    }
    memcpy(real_buf, temp_real, FFT_SIZE * sizeof(float));
    memset(imag_buf, 0, FFT_SIZE * sizeof(float));

    for (int step = 2, half_step = 1; step <= FFT_SIZE; step <<= 1, half_step <<= 1) {
        int twiddle_step = FFT_SIZE / step;

        for (int i = 0; i < FFT_SIZE; i += step) {
            int j = 0;
            if (half_step >= 4) {
                for (; j <= half_step - 4; j += 4) {
                    int t_idx[4] = { j*twiddle_step, (j+1)*twiddle_step, (j+2)*twiddle_step, (j+3)*twiddle_step };
                    v128_t wr_vec = wasm_f32x4_make(cos_table[t_idx[0]], cos_table[t_idx[1]], cos_table[t_idx[2]], cos_table[t_idx[3]]);
                    v128_t wi_vec = wasm_f32x4_make(sin_table[t_idx[0]], sin_table[t_idx[1]], sin_table[t_idx[2]], sin_table[t_idx[3]]);

                    int even_idx = i + j;
                    int odd_idx = i + j + half_step;

                    v128_t er_vec = wasm_v128_load(&real_buf[even_idx]);
                    v128_t ei_vec = wasm_v128_load(&imag_buf[even_idx]);

                    v128_t or_vec = wasm_v128_load(&real_buf[odd_idx]);
                    v128_t oi_vec = wasm_v128_load(&imag_buf[odd_idx]);

                    v128_t tr_vec = wasm_f32x4_sub(wasm_f32x4_mul(wr_vec, or_vec), wasm_f32x4_mul(wi_vec, oi_vec));
                    v128_t ti_vec = wasm_f32x4_add(wasm_f32x4_mul(wr_vec, oi_vec), wasm_f32x4_mul(wi_vec, or_vec));

                    wasm_v128_store(&real_buf[even_idx], wasm_f32x4_add(er_vec, tr_vec));
                    wasm_v128_store(&imag_buf[even_idx], wasm_f32x4_add(ei_vec, ti_vec));

                    wasm_v128_store(&real_buf[odd_idx], wasm_f32x4_sub(er_vec, tr_vec));
                    wasm_v128_store(&imag_buf[odd_idx], wasm_f32x4_sub(ei_vec, ti_vec));
                }
            }
            for (; j < half_step; j++) {
                int twiddle_idx = j * twiddle_step;
                float wr = cos_table[twiddle_idx];
                float wi = sin_table[twiddle_idx];

                int even_idx = i + j;
                int odd_idx = i + j + half_step;

                float er = real_buf[even_idx];
                float ei = imag_buf[even_idx];

                float or_ = real_buf[odd_idx];
                float oi = imag_buf[odd_idx];

                float tr = wr * or_ - wi * oi;
                float ti = wr * oi + wi * or_;

                real_buf[even_idx] = er + tr;
                imag_buf[even_idx] = ei + ti;

                real_buf[odd_idx] = er - tr;
                imag_buf[odd_idx] = ei - ti;
            }
        }
    }
}

// Computes 1/3-octave band energy summaries.
// We approximate 31 ISO 1/3 octave bands (from 20Hz to 20kHz).
// Assumes sample rate is 48000Hz.
// Bin frequency = i * 48000 / 1024.
void compute_octave_bands() {
    // Zero out output
    memset(octave_bands, 0, NUM_OCTAVE_BANDS * sizeof(float));

    // Calculate magnitudes first
    int i = 0;
    for (; i <= NUM_BINS - 4; i += 4) {
        v128_t r_vec = wasm_v128_load(&real_buf[i]);
        v128_t i_vec = wasm_v128_load(&imag_buf[i]);
        v128_t r2 = wasm_f32x4_mul(r_vec, r_vec);
        v128_t i2 = wasm_f32x4_mul(i_vec, i_vec);
        v128_t mag_sq = wasm_f32x4_add(r2, i2);

        v128_t mag = wasm_f32x4_sqrt(mag_sq);
        wasm_v128_store(&real_buf[i], mag); // store back in real_buf for simplicity
    }
    for (; i < NUM_BINS; i++) {
        real_buf[i] = sqrtf(real_buf[i] * real_buf[i] + imag_buf[i] * imag_buf[i]);
    }

    // Frequencies (center freq of bands): 20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000
    // Simplify matching bins to 31 bands.
    float sample_rate = 48000.0f;
    float bin_width = sample_rate / FFT_SIZE;

    // For simplicity, partition the log scale into 31 bands manually.
    // Lower cutoff freq = 20 * 2^((k-1/2)/3), Upper = 20 * 2^((k+1/2)/3)

    for (int bin = 1; bin < NUM_BINS; bin++) {
        float freq = bin * bin_width;

        // Find which band it belongs to.
        int band = -1;
        float center = 20.0f;
        for (int k = 0; k < 31; k++) {
            float lower = center * pow(2.0f, -1.0f/6.0f);
            float upper = center * pow(2.0f, 1.0f/6.0f);

            if (freq >= lower && freq < upper) {
                band = k;
                break;
            } else if (k == 30 && freq >= upper) {
                band = 30; // dump rest in highest band
                break;
            }
            center = center * pow(2.0f, 1.0f/3.0f);
        }

        if (band >= 0) {
            octave_bands[band] += real_buf[bin];
        }
    }
}

float calculate_rms() {
    float sum = 0.0f;
    for (int i = 0; i < FFT_SIZE; i++) {
        sum += real_buf[i] * real_buf[i];
    }
    return sqrtf(sum / FFT_SIZE);
}

} // extern "C"
