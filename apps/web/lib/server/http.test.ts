import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { getClientIp, MAX_REQUEST_BYTES, readJsonBody } from "@/lib/server/http";

describe("getClientIp", () => {
    it("Caddyが生成したX-Forwarded-Forの先頭だけを使用する", () => {
        const request = new NextRequest("http://localhost/api/executions", {
            headers: {
                "x-forwarded-for": "203.0.113.10, 10.0.0.2",
                "cf-connecting-ip": "198.51.100.20",
                "x-real-ip": "198.51.100.30",
            },
        });

        expect(getClientIp(request)).toBe("203.0.113.10");
    });

    it("X-Forwarded-Forがなければunknownとして同一の厳しい枠へ集約する", () => {
        const request = new NextRequest("http://localhost/api/executions", {
            headers: {
                "cf-connecting-ip": "198.51.100.20",
            },
        });

        expect(getClientIp(request)).toBe("unknown");
    });

    it("上限内のストリーム本文をJSONとして読み込む", async () => {
        const request = new NextRequest("http://localhost/api/executions", {
            method: "POST",
            body: JSON.stringify({
                source: "int main(void) { return 0; }",
            }),
        });

        await expect(readJsonBody(request)).resolves.toEqual({
            source: "int main(void) { return 0; }",
        });
    });

    it("Content-Lengthがなくても上限超過を読み込み途中で拒否する", async () => {
        const request = new NextRequest("http://localhost/api/executions", {
            method: "POST",
            body: JSON.stringify({
                source: "a".repeat(MAX_REQUEST_BYTES),
            }),
        });
        const response = await readJsonBody(request);

        expect(response).toHaveProperty("status", 413);
    });

    it("JSON escape後に64KiBを超える有効なソース本文を受理する", async () => {
        const source = "\n".repeat(64 * 1024);
        const request = new NextRequest("http://localhost/api/lsp/sessions", {
            method: "POST",
            body: JSON.stringify({ source }),
        });

        await expect(readJsonBody(request)).resolves.toEqual({ source });
    });
});
