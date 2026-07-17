/**
 * 同一オリジンのHTTPパスをWebSocket URLへ変換します。
 */
export function toWebSocketUrl(path: string): string {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}${path}`;
}

/**
 * WebSocketへJSON制御メッセージを送信します。
 */
export function sendJsonMessage(socket: WebSocket | null, message: object): boolean {
    if (socket === null || socket.readyState !== WebSocket.OPEN) {
        return false;
    }

    socket.send(JSON.stringify(message));
    return true;
}
