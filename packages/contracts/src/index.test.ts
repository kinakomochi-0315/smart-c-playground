import assert from "node:assert/strict";
import test from "node:test";
import { isTerminalSize, isValidSource, SOURCE_MAX_BYTES, TERMINAL_COLS_MAX, TERMINAL_COLS_MIN } from "./index.js";

test("isTerminalSizeは許可範囲内の整数を受け付ける", () => {
    assert.equal(isTerminalSize({ cols: 100, rows: 30 }), true);
    assert.equal(isTerminalSize({ cols: TERMINAL_COLS_MIN - 1, rows: 30 }), false);
    assert.equal(isTerminalSize({ cols: TERMINAL_COLS_MAX + 1, rows: 30 }), false);
    assert.equal(isTerminalSize({ cols: 100.5, rows: 30 }), false);
});

test("isValidSourceはNUL文字と上限超過を拒否する", () => {
    assert.equal(isValidSource("int main(void) { return 0; }"), true);
    assert.equal(isValidSource("int\0main"), false);
    assert.equal(isValidSource("a".repeat(SOURCE_MAX_BYTES + 1)), false);
});
