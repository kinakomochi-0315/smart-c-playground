import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";

import { POST as createExecution } from "@/app/api/executions/route";
import { resetRateLimitStore } from "@/lib/server/rate-limit";

describe("API request rate limit", () => {
    beforeEach(() => {
        resetRateLimitStore();
        process.env.VISITOR_COOKIE_SECRET = "test-visitor-cookie-secret-at-least-32-bytes";
    });

    it("解析できないJSONもIP単位の粗い制限へ計上する", async () => {
        for (let index = 0; index < 30; index += 1) {
            const response = await createExecution(createInvalidJsonRequest());
            expect(response.status).toBe(400);
        }

        const limited = await createExecution(createInvalidJsonRequest());
        expect(limited.status).toBe(429);
        expect(limited.headers.get("retry-after")).toBe("60");
    });
});

/**
 * 同一IPから送られた不正JSONのテストリクエストを作成します。
 */
function createInvalidJsonRequest(): NextRequest {
    return new NextRequest("http://localhost:8080/api/executions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Host: "localhost:8080",
            Origin: "http://localhost:8080",
            "X-Forwarded-For": "192.0.2.55",
            "X-Forwarded-Proto": "http",
        },
        body: "{",
    });
}
