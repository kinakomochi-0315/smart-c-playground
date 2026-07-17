import { beforeEach, describe, expect, it, vi } from "vitest";

import {
    DEFAULT_SOURCE,
    loadProject,
    PROJECT_STORAGE_KEY,
    saveProject,
    SOURCE_STORAGE_KEY,
} from "@/lib/client/storage";

describe("project storage", () => {
    const values = new Map<string, string>();

    beforeEach(() => {
        values.clear();
        vi.stubGlobal("localStorage", {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => values.set(key, value),
            removeItem: (key: string) => values.delete(key),
        });
    });

    it("v1のsourceをmain.cへ移行する", () => {
        values.set(SOURCE_STORAGE_KEY, "int main(void) { return 1; }");

        expect(loadProject()).toEqual({
            files: [{ name: "main.c", content: "int main(void) { return 1; }" }],
            activeFileName: "main.c",
        });
    });

    it("v2保存後はv1のsourceを削除する", () => {
        values.set(SOURCE_STORAGE_KEY, DEFAULT_SOURCE);
        const project = {
            files: [
                { name: "main.c", content: "int main(void) { return answer(); }" },
                { name: "answer.c", content: "int answer(void) { return 42; }" },
            ],
            activeFileName: "answer.c",
        };

        expect(saveProject(project)).toBe(true);
        expect(values.has(SOURCE_STORAGE_KEY)).toBe(false);
        expect(JSON.parse(values.get(PROJECT_STORAGE_KEY)!)).toEqual(project);
    });

    it("サーバー上限を超えた編集中の内容も再読み込みできる", () => {
        const project = {
            files: [{ name: "main.c", content: "a".repeat(64 * 1024 + 1) }],
            activeFileName: "main.c",
        };
        saveProject(project);

        expect(loadProject()).toEqual(project);
    });
});
