import { describe, expect, it } from "vitest";

import { validateExecutionRequest, validateLspSessionRequest } from "@/lib/server/validation";

describe("validation", () => {
    it("空のC言語ソースもコンパイラへ渡せる", () => {
        expect(validateLspSessionRequest({ source: "" }).value).toEqual({
            source: "",
        });
    });

    it("64KiBを超えるソースを拒否する", () => {
        const result = validateLspSessionRequest({
            source: "a".repeat(64 * 1024 + 1),
        });

        expect(result.error).toContain("64KiB");
    });

    it("実行時の端末サイズを範囲内に制限する", () => {
        expect(
            validateExecutionRequest({
                source: "int main(void) { return 0; }",
                terminal: {
                    cols: 100,
                    rows: 30,
                },
            }).value,
        ).toBeDefined();
        expect(
            validateExecutionRequest({
                source: "",
                terminal: {
                    cols: 10,
                    rows: 30,
                },
            }).error,
        ).toContain("terminal.cols");
    });
});
