export interface RateLimitRule {
    key: string;
    limit: number;
    windowMs: number;
}

export interface RateLimitResult {
    allowed: boolean;
    remaining: number;
    retryAfterSeconds: number;
}

interface RateLimitEntry {
    count: number;
    resetAt: number;
}

export const MAX_RATE_LIMIT_ENTRIES = 10_000;
const CLEANUP_INTERVAL = 256;
let operationCount = 0;

declare global {
    var smartCRateLimitStore: Map<string, RateLimitEntry> | undefined;
}

const store = globalThis.smartCRateLimitStore ?? (globalThis.smartCRateLimitStore = new Map<string, RateLimitEntry>());

/**
 * 期限切れエントリーを削除し、匿名アクセスの増加による常駐メモリ増大を防ぎます。
 */
function cleanupExpiredEntries(now: number): void {
    for (const [key, entry] of store) {
        if (entry.resetAt <= now) {
            store.delete(key);
        }
    }
}

/**
 * 単一プロセス内の固定ウィンドウ方式で、指定されたレート制限を消費します。
 */
export function consumeRateLimit(rule: RateLimitRule, now = Date.now()): RateLimitResult {
    operationCount += 1;
    if (operationCount % CLEANUP_INTERVAL === 0 || store.size >= MAX_RATE_LIMIT_ENTRIES) {
        cleanupExpiredEntries(now);
    }

    if (!store.has(rule.key) && store.size >= MAX_RATE_LIMIT_ENTRIES) {
        return {
            allowed: false,
            remaining: 0,
            retryAfterSeconds: Math.max(1, Math.ceil(rule.windowMs / 1_000)),
        };
    }

    const existing = store.get(rule.key);
    const entry =
        existing === undefined || existing.resetAt <= now
            ? {
                  count: 0,
                  resetAt: now + rule.windowMs,
              }
            : existing;

    entry.count += 1;
    store.set(rule.key, entry);

    const allowed = entry.count <= rule.limit;
    return {
        allowed,
        remaining: Math.max(0, rule.limit - entry.count),
        retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((entry.resetAt - now) / 1_000)),
    };
}

/**
 * 複数のレート制限を同時に評価し、最も長い待機時間を返します。
 */
export function consumeRateLimits(rules: RateLimitRule[], now = Date.now()): RateLimitResult {
    const results = rules.map((rule) => consumeRateLimit(rule, now));
    const denied = results.filter((result) => !result.allowed);

    if (denied.length > 0) {
        return {
            allowed: false,
            remaining: 0,
            retryAfterSeconds: Math.max(...denied.map((result) => result.retryAfterSeconds)),
        };
    }

    return {
        allowed: true,
        remaining: Math.min(...results.map((result) => result.remaining)),
        retryAfterSeconds: 0,
    };
}

/**
 * テスト間でインメモリのレート制限状態を初期化します。
 */
export function resetRateLimitStore(): void {
    store.clear();
    operationCount = 0;
}
