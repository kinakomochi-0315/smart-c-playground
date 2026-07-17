import { NextResponse } from "next/server";

import { checkDependencyReadiness } from "@/lib/server/services";

export const dynamic = "force-dynamic";

/**
 * 外部監視向けにWeb・LSP・Executorをまとめたreadinessを返します。
 */
export async function GET(): Promise<NextResponse> {
    const readiness = await checkDependencyReadiness();

    return NextResponse.json(
        {
            status: readiness.ready ? "ready" : "not_ready",
            services: {
                web: true,
                ...readiness.services,
            },
        },
        {
            status: readiness.ready ? 200 : 503,
        },
    );
}
