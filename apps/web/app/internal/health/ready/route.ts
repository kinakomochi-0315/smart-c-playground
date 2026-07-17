import { NextResponse } from "next/server";

import { checkDependencyReadiness } from "@/lib/server/services";

export const dynamic = "force-dynamic";

/**
 * 内部オーケストレーター向けに依存サービスを含むreadinessを返します。
 */
export async function GET(): Promise<NextResponse> {
    const readiness = await checkDependencyReadiness();

    return NextResponse.json(
        {
            status: readiness.ready ? "ready" : "not_ready",
            services: readiness.services,
        },
        {
            status: readiness.ready ? 200 : 503,
        },
    );
}
