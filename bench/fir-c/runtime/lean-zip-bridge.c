#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include <lean/lean.h>

#define FIR_LEAN_ZIP_MAX_INPUT_BYTES (4U * 1024U * 1024U)

lean_object *fir_lean_zip_c_compress_raw(lean_object *input, uint8_t level);

static uint8_t *fir_lean_zip_input = NULL;
static uint32_t fir_lean_zip_input_capacity = 0;
static uint8_t *fir_lean_zip_result = NULL;
static uint32_t fir_lean_zip_result_size = 0;

static void fir_lean_zip_clear_result(void) {
    free(fir_lean_zip_result);
    fir_lean_zip_result = NULL;
    fir_lean_zip_result_size = 0;
}

LEAN_EXPORT uint32_t fir_lean_zip_c_input_alloc(uint32_t size) {
    uint8_t *next;

    if (size > FIR_LEAN_ZIP_MAX_INPUT_BYTES) {
        return 0;
    }
    free(fir_lean_zip_input);
    fir_lean_zip_input = NULL;
    fir_lean_zip_input_capacity = 0;
    if (size == 0) {
        return 1;
    }
    next = malloc(size);
    if (next == NULL) {
        return 0;
    }
    fir_lean_zip_input = next;
    fir_lean_zip_input_capacity = size;
    return (uint32_t)(uintptr_t)next;
}

LEAN_EXPORT uint32_t fir_lean_zip_c_compress(uint32_t size, uint32_t level) {
    lean_object *input;
    lean_object *result;
    size_t result_size;

    fir_lean_zip_clear_result();
    if (level < 1 || level > 10) {
        return 1;
    }
    if (size > fir_lean_zip_input_capacity ||
        (size != 0 && fir_lean_zip_input == NULL)) {
        return 2;
    }
    input = lean_alloc_sarray(1, size, size);
    if (size != 0) {
        memcpy(lean_sarray_cptr(input), fir_lean_zip_input, size);
    }
    result = fir_lean_zip_c_compress_raw(input, (uint8_t)level);
    result_size = lean_sarray_size(result);
    if (result_size > UINT32_MAX) {
        lean_dec(result);
        return 3;
    }
    if (result_size != 0) {
        fir_lean_zip_result = malloc(result_size);
        if (fir_lean_zip_result == NULL) {
            lean_dec(result);
            return 4;
        }
        memcpy(fir_lean_zip_result, lean_sarray_cptr(result), result_size);
    }
    fir_lean_zip_result_size = (uint32_t)result_size;
    lean_dec(result);
    return 0;
}

LEAN_EXPORT uint32_t fir_lean_zip_c_result_ptr(void) {
    return (uint32_t)(uintptr_t)fir_lean_zip_result;
}

LEAN_EXPORT uint32_t fir_lean_zip_c_result_len(void) {
    return fir_lean_zip_result_size;
}

LEAN_EXPORT void fir_lean_zip_c_release(void) {
    free(fir_lean_zip_input);
    fir_lean_zip_input = NULL;
    fir_lean_zip_input_capacity = 0;
    fir_lean_zip_clear_result();
}
