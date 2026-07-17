import assert from "node:assert/strict";
import test from "node:test";

import { TicketService } from "./ticket.js";

test("署名済みチケットを期待した接続先だけで検証できる", () => {
    let now = 1_000;
    const service = new TicketService("s".repeat(32), () => now);
    const issued = service.issue("session-1", "visitor-1", "/ws/lsp/session-1", 30_000);

    assert.equal(
        service.verify(issued.ticket, {
            sessionId: "session-1",
            visitorId: "visitor-1",
            path: "/ws/lsp/session-1",
        }).valid,
        true,
    );
    assert.equal(
        service.verify(issued.ticket, {
            sessionId: "session-1",
            visitorId: "visitor-1",
            path: "/ws/lsp/another",
        }).valid,
        false,
    );

    now = 31_000;
    assert.deepEqual(
        service.verify(issued.ticket, {
            sessionId: "session-1",
            visitorId: "visitor-1",
            path: "/ws/lsp/session-1",
        }),
        { valid: false, reason: "expired" },
    );
});

test("改ざんされたチケットを拒否する", () => {
    const service = new TicketService("s".repeat(32), () => 1_000);
    const issued = service.issue("session-1", "visitor-1", "/ws/lsp/session-1", 30_000);
    const tampered = `${issued.ticket.slice(0, -1)}x`;

    assert.deepEqual(
        service.verify(tampered, {
            sessionId: "session-1",
            visitorId: "visitor-1",
            path: "/ws/lsp/session-1",
        }),
        { valid: false, reason: "invalid" },
    );
});
