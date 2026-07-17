import type { PersistedSettings } from "@/types/wire";

export const SOURCE_STORAGE_KEY = "smart-c-playground:v1:source";
export const SETTINGS_STORAGE_KEY = "smart-c-playground:v1:settings";

export const DEFAULT_SOURCE = `#include <stdio.h>

int main(void) {
    char name[64];

    printf("名前を入力してください: ");
    fflush(stdout);

    if (fgets(name, sizeof(name), stdin) == NULL) {
        return 1;
    }

    printf("こんにちは、%s", name);
    return 0;
}
`;

export const DEFAULT_SETTINGS: PersistedSettings = {
    paneRatio: 55,
    activeTab: "code",
};

/**
 * localStorageからソースを安全に読み込みます。
 */
export function loadSource(): string {
    try {
        return localStorage.getItem(SOURCE_STORAGE_KEY) ?? DEFAULT_SOURCE;
    } catch {
        return DEFAULT_SOURCE;
    }
}

/**
 * ソースをlocalStorageへ保存し、容量不足時は失敗を呼び出し元へ返します。
 */
export function saveSource(source: string): boolean {
    try {
        localStorage.setItem(SOURCE_STORAGE_KEY, source);
        return true;
    } catch {
        return false;
    }
}

/**
 * 保存済みUI設定を検証し、破損時は既定値へ戻します。
 */
export function loadSettings(): PersistedSettings {
    try {
        const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
        if (raw === null) {
            return DEFAULT_SETTINGS;
        }

        const value = JSON.parse(raw) as Partial<PersistedSettings>;
        return {
            paneRatio:
                typeof value.paneRatio === "number" && value.paneRatio >= 35 && value.paneRatio <= 75
                    ? value.paneRatio
                    : DEFAULT_SETTINGS.paneRatio,
            activeTab:
                value.activeTab === "code" || value.activeTab === "io" ? value.activeTab : DEFAULT_SETTINGS.activeTab,
        };
    } catch {
        return DEFAULT_SETTINGS;
    }
}

/**
 * UI設定をlocalStorageへ保存します。
 */
export function saveSettings(settings: PersistedSettings): boolean {
    try {
        localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
        return true;
    } catch {
        return false;
    }
}
