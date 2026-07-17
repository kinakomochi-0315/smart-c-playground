import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Next.jsプロセス自身のlivenessを返します。
 */
export function GET(): NextResponse {
    return NextResponse.json({
        status: "alive",
    });
}
