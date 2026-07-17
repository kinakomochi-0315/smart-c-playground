import { describe, expect, it } from "vitest";

import { validateExecutionRequest, validateLspSessionRequest } from "@/lib/server/validation";

describe("validation", () => {
    it("空のC言語ソースもコンパイラへ渡せる", () => {
        expect(validateLspSessionRequest({ files: [{ name: "main.c", content: "" }] }).value).toEqual({
            files: [{ name: "main.c", content: "" }],
        });
    });

    it("64KiBを超えるソースを拒否する", () => {
        const result = validateLspSessionRequest({
            files: [{ name: "main.c", content: "a".repeat(64 * 1024 + 1) }],
        });

        expect(result.error).toContain("64KiB");
    });

    it("実行時の端末サイズを範囲内に制限する", () => {
        expect(
            validateExecutionRequest({
                files: [
                    { name: "main.c", content: "int main(void) { return answer(); }" },
                    { name: "answer.c", content: "int answer(void) { return 0; }" },
                ],
                terminal: {
                    cols: 100,
                    rows: 30,
                },
            }).value,
        ).toBeDefined();
        expect(
            validateExecutionRequest({
                files: [{ name: "main.c", content: "" }],
                terminal: {
                    cols: 10,
                    rows: 30,
                },
            }).error,
        ).toContain("terminal.cols");
    });

    it("パス、重複名、main.c欠落を拒否する", () => {
        expect(validateLspSessionRequest({ files: [{ name: "../main.c", content: "" }] }).error).toContain(
            "ファイル名",
        );
        expect(
            validateLspSessionRequest({
                files: [
                    { name: "main.c", content: "" },
                    { name: "MAIN.c", content: "" },
                ],
            }).error,
        ).toContain("同じファイル名");
        expect(validateLspSessionRequest({ files: [{ name: "aaa.c", content: "" }] }).error).toContain("main.c");
    });
});
