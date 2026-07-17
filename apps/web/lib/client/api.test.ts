import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, createExecution } from "@/lib/client/api";

describe("client api", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("Proxyの非JSON 413をサイズ超過エラーとして復元する", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(
                new Response("Payload Too Large", {
                    status: 413,
                }),
            ),
        );

        const promise = createExecution({
            source: "int main(void) { return 0; }",
            terminal: {
                cols: 100,
                rows: 30,
            },
        });

        await expect(promise).rejects.toBeInstanceOf(ApiError);
        await expect(promise).rejects.toMatchObject({
            status: 413,
            message: "C言語ソースは64KiB以内にしてください。",
        });
    });

    it("JSONの成功応答をそのまま返す", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(
                Response.json(
                    {
                        id: "execution-id",
                        webSocketPath: "/ws/executions/execution-id",
                        expiresAt: "2026-07-16T12:00:00.000Z",
                    },
                    {
                        status: 201,
                    },
                ),
            ),
        );

        await expect(
            createExecution({
                source: "",
                terminal: {
                    cols: 100,
                    rows: 30,
                },
            }),
        ).resolves.toMatchObject({
            id: "execution-id",
        });
    });
});
