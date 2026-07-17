import { beforeEach, describe, expect, it } from "vitest";

import {
    consumeRateLimit,
    consumeRateLimits,
    MAX_RATE_LIMIT_ENTRIES,
    resetRateLimitStore,
} from "@/lib/server/rate-limit";

describe("rate-limit", () => {
    beforeEach(() => {
        resetRateLimitStore();
    });

    it("上限までは許可し、超過時に待機時間を返す", () => {
        const rule = {
            key: "test",
            limit: 2,
            windowMs: 1_000,
        };

        expect(consumeRateLimit(rule, 0).allowed).toBe(true);
        expect(consumeRateLimit(rule, 10).allowed).toBe(true);
        expect(consumeRateLimit(rule, 20)).toEqual({
            allowed: false,
            remaining: 0,
            retryAfterSeconds: 1,
        });
    });

    it("新しいウィンドウでは回数を初期化する", () => {
        const rule = {
            key: "reset",
            limit: 1,
            windowMs: 1_000,
        };

        expect(consumeRateLimit(rule, 0).allowed).toBe(true);
        expect(consumeRateLimit(rule, 100).allowed).toBe(false);
        expect(consumeRateLimit(rule, 1_000).allowed).toBe(true);
    });

    it("複数ルールのうち一つでも超過すると拒否する", () => {
        const rules = [
            {
                key: "short",
                limit: 1,
                windowMs: 1_000,
            },
            {
                key: "long",
                limit: 10,
                windowMs: 10_000,
            },
        ];

        expect(consumeRateLimits(rules, 0).allowed).toBe(true);
        expect(consumeRateLimits(rules, 100).allowed).toBe(false);
    });

    it("最大件数を超える新規キーを安全側で拒否する", () => {
        for (let index = 0; index < MAX_RATE_LIMIT_ENTRIES; index += 1) {
            expect(
                consumeRateLimit(
                    {
                        key: `visitor-${index}`,
                        limit: 1,
                        windowMs: 1_000,
                    },
                    0,
                ).allowed,
            ).toBe(true);
        }

        expect(
            consumeRateLimit(
                {
                    key: "overflow",
                    limit: 1,
                    windowMs: 1_000,
                },
                0,
            ).allowed,
        ).toBe(false);
    });

    it("上限到達後も期限切れを掃除して新規キーを受け付ける", () => {
        for (let index = 0; index < MAX_RATE_LIMIT_ENTRIES; index += 1) {
            consumeRateLimit(
                {
                    key: `expired-${index}`,
                    limit: 1,
                    windowMs: 1_000,
                },
                0,
            );
        }

        expect(
            consumeRateLimit(
                {
                    key: "after-cleanup",
                    limit: 1,
                    windowMs: 1_000,
                },
                1_000,
            ).allowed,
        ).toBe(true);
    });
});
