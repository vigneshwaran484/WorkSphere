#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUTPUT_DIR="$PROJECT_ROOT/public/workers"
SRC_FILE="$SCRIPT_DIR/fft_processor.cpp"
OUTPUT_FILE="$OUTPUT_DIR/fft-processor.wasm"

mkdir -p "$OUTPUT_DIR"

echo "Building WASM SIMD FFT Processor..."

source $PROJECT_ROOT/emsdk/emsdk_env.sh

em++ \
    -O3 \
    -msimd128 \
    -s WASM=1 \
    -s EXPORTED_FUNCTIONS='["_init_fft","_get_real_ptr","_get_octave_bands_ptr","_compute_fft_simd","_compute_octave_bands","_calculate_rms"]' \
    -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap"]' \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s ENVIRONMENT='web,worker' \
    -s FILESYSTEM=0 \
    -s NO_DYNAMIC_EXECUTION=1 \
    --no-entry \
    "$SRC_FILE" \
    -o "$OUTPUT_FILE"

WASM_SIZE=$(stat -f%z "$OUTPUT_FILE" 2>/dev/null || stat -c%s "$OUTPUT_FILE" 2>/dev/null || echo "unknown")
echo "Build complete: $OUTPUT_FILE ($WASM_SIZE bytes)"
