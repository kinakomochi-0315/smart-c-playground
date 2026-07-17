import { isValidSourceFileName, SOURCE_FILE_MAX_COUNT } from "@smart-c/contracts";

import type { PersistedProject, PersistedSettings } from "@/types/wire";

export const SOURCE_STORAGE_KEY = "smart-c-playground:v1:source";
export const PROJECT_STORAGE_KEY = "smart-c-playground:v2:project";
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

export const DEFAULT_PROJECT: PersistedProject = {
    files: [{ name: "main.c", content: DEFAULT_SOURCE }],
    activeFileName: "main.c",
};

/**
 * サーバー上限を超えた編集中の内容も失わず、保存形式の構造だけを検証します。
 */
function isPersistedProjectFiles(value: unknown): value is PersistedProject["files"] {
    if (!Array.isArray(value) || value.length === 0 || value.length > SOURCE_FILE_MAX_COUNT) {
        return false;
    }

    const names = new Set<string>();
    for (const file of value) {
        if (
            typeof file !== "object" ||
            file === null ||
            !isValidSourceFileName((file as { name?: unknown }).name) ||
            typeof (file as { content?: unknown }).content !== "string"
        ) {
            return false;
        }
        const name = (file as { name: string }).name.toLowerCase();
        if (names.has(name)) {
            return false;
        }
        names.add(name);
    }
    return names.has("main.c");
}

/**
 * localStorageからプロジェクトを読み込み、v1のmain.cだけを一度移行します。
 */
export function loadProject(): PersistedProject {
    try {
        const raw = localStorage.getItem(PROJECT_STORAGE_KEY);
        if (raw !== null) {
            const value = JSON.parse(raw) as Partial<PersistedProject>;
            if (isPersistedProjectFiles(value.files)) {
                return {
                    files: value.files,
                    activeFileName:
                        typeof value.activeFileName === "string" &&
                        value.files.some((file) => file.name === value.activeFileName)
                            ? value.activeFileName
                            : "main.c",
                };
            }
        }

        return {
            files: [
                {
                    name: "main.c",
                    content: localStorage.getItem(SOURCE_STORAGE_KEY) ?? DEFAULT_SOURCE,
                },
            ],
            activeFileName: "main.c",
        };
    } catch {
        return DEFAULT_PROJECT;
    }
}

/**
 * プロジェクトをlocalStorageへ保存し、成功後にv1のソースを削除します。
 */
export function saveProject(project: PersistedProject): boolean {
    try {
        localStorage.setItem(PROJECT_STORAGE_KEY, JSON.stringify(project));
        localStorage.removeItem(SOURCE_STORAGE_KEY);
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
