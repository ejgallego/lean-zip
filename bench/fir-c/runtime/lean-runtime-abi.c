#include <stdint.h>

#include <lean/lean.h>

/*
 * Lean-generated C declares Bool arguments as uint8_t. The C++ Lean runtime
 * defines this primitive with bool, which is ABI-compatible after ordinary C
 * compilation but becomes i8 versus i1 under LLVM whole-program LTO. Keep the
 * two signatures separated by a real C wrapper until the shared FIR
 * Emscripten runtime exposes a generated-C-compatible entry point.
 */
extern lean_obj_res lean_byte_array_copy_slice(
    b_lean_obj_arg src,
    lean_obj_arg src_off,
    lean_obj_arg dest,
    lean_obj_arg dest_off,
    lean_obj_arg len,
    bool exact);
extern lean_object *l_ByteArray_empty;

LEAN_EXPORT lean_obj_res fir_lean_byte_array_copy_slice_u8(
    b_lean_obj_arg src,
    lean_obj_arg src_off,
    lean_obj_arg dest,
    lean_obj_arg dest_off,
    lean_obj_arg len,
    uint8_t exact) {
    return lean_byte_array_copy_slice(
        src, src_off, dest, dest_off, len, exact != 0);
}

LEAN_EXPORT lean_obj_res fir_lean_byte_array_extract_u8(
    b_lean_obj_arg src,
    lean_obj_arg begin,
    lean_obj_arg end) {
    lean_obj_res len = lean_nat_sub(end, begin);
    return fir_lean_byte_array_copy_slice_u8(
        src, begin, l_ByteArray_empty, lean_box(0), len, 1);
}
