import type { SpawnOptionsWithoutStdio } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SANDBOX_WORKSPACE_PATH = "/workspace";
const CLANGD_ADDRESS_SPACE_BYTES = 384 * 1024 * 1024;
const CLANGD_CPU_SECONDS = 60;
const CLANGD_MAX_OPEN_FILES = 128;
const CLANGD_MAX_FILE_BYTES = 64 * 1024 * 1024;

/**
 * clangd子プロセスを起動するための完全な指定です。
 */
export interface ClangdProcessSpec {
    command: string;
    arguments: string[];
    options: SpawnOptionsWithoutStdio;
}

/**
 * clangd起動指定の入力です。
 */
export interface ClangdProcessOptions {
    clangdPath: string;
    workspacePath: string;
    sandboxPath?: string;
    limiterPath?: string;
    clangdArguments?: string[];
    hiddenPathForSmokeTest?: string;
}

/**
 * セッションごとのclangdを、必要ならbubblewrapとprlimitで包んだ起動指定へ変換します。
 */
export function createClangdProcessSpec(options: ClangdProcessOptions): ClangdProcessSpec {
    const workspacePath = resolve(options.workspacePath);
    const clangdWorkspacePath = options.sandboxPath === undefined ? workspacePath : SANDBOX_WORKSPACE_PATH;
    const clangdArguments = options.clangdArguments ?? createClangdArguments(clangdWorkspacePath);
    const limitedCommand = createLimitedCommand(options.clangdPath, clangdArguments, options.limiterPath);

    if (options.sandboxPath === undefined) {
        return {
            command: limitedCommand.command,
            arguments: limitedCommand.arguments,
            options: {
                cwd: workspacePath,
                env: createClangdEnvironment(workspacePath),
                shell: false,
            },
        };
    }

    return {
        command: options.sandboxPath,
        arguments: createBubblewrapArguments(
            workspacePath,
            limitedCommand.command,
            limitedCommand.arguments,
            options.hiddenPathForSmokeTest,
        ),
        options: {
            cwd: workspacePath,
            env: createClangdEnvironment(workspacePath),
            shell: false,
        },
    };
}

/**
 * ブラウザとsandbox内clangdが共有するmain.c URIを返します。
 */
export function createClangdDocumentUri(workspacePath: string, sandboxEnabled: boolean, fileName: string): string {
    const clangdWorkspacePath = sandboxEnabled ? SANDBOX_WORKSPACE_PATH : resolve(workspacePath);
    return pathToFileURL(join(clangdWorkspacePath, fileName)).href;
}

/**
 * ブラウザとsandbox内clangdが共有するworkspace URIを返します。
 */
export function createClangdWorkspaceUri(workspacePath: string, sandboxEnabled: boolean): string {
    return pathToFileURL(sandboxEnabled ? SANDBOX_WORKSPACE_PATH : resolve(workspacePath)).href;
}

/**
 * clangdへ必要最小限の環境変数だけを渡し、サービス秘密値の継承を防ぎます。
 */
export function createClangdEnvironment(workspacePath: string): NodeJS.ProcessEnv {
    return {
        PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        HOME: workspacePath,
        XDG_CACHE_HOME: join(workspacePath, ".cache"),
        TMPDIR: workspacePath,
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
    };
}

/**
 * C17学習用途に不要なclangd機能と出力量を抑えた引数を返します。
 */
function createClangdArguments(workspacePath: string): string[] {
    return [
        "--background-index=false",
        "--clang-tidy=false",
        `--compile-commands-dir=${workspacePath}`,
        "--completion-style=detailed",
        "--enable-config=false",
        "--header-insertion=never",
        "--limit-references=100",
        "--limit-results=100",
        "-j=1",
        "--pch-storage=disk",
        "--log=error",
    ];
}

/**
 * prlimitが設定されていればclangdのCPU・仮想メモリ・FD・生成ファイルを制限します。
 */
function createLimitedCommand(
    clangdPath: string,
    clangdArguments: string[],
    limiterPath: string | undefined,
): { command: string; arguments: string[] } {
    if (limiterPath === undefined) {
        return {
            command: clangdPath,
            arguments: clangdArguments,
        };
    }

    return {
        command: limiterPath,
        arguments: [
            `--as=${CLANGD_ADDRESS_SPACE_BYTES}:${CLANGD_ADDRESS_SPACE_BYTES}`,
            `--cpu=${CLANGD_CPU_SECONDS}:${CLANGD_CPU_SECONDS}`,
            `--nofile=${CLANGD_MAX_OPEN_FILES}:${CLANGD_MAX_OPEN_FILES}`,
            `--fsize=${CLANGD_MAX_FILE_BYTES}:${CLANGD_MAX_FILE_BYTES}`,
            "--core=0:0",
            "--",
            clangdPath,
            ...clangdArguments,
        ],
    };
}

/**
 * workspaceだけをRWで見せ、system runtimeをRO、/procを空にしたbubblewrap引数を返します。
 */
function createBubblewrapArguments(
    workspacePath: string,
    command: string,
    commandArguments: string[],
    hiddenPathForSmokeTest: string | undefined,
): string[] {
    const sandboxCommand =
        hiddenPathForSmokeTest === undefined
            ? [command, ...commandArguments]
            : [
                  "/bin/sh",
                  "-c",
                  'test -w /workspace && test ! -e /proc/1 && test ! -e "$1" && shift && exec "$@"',
                  "sandbox-smoke",
                  hiddenPathForSmokeTest,
                  command,
                  ...commandArguments,
              ];

    return [
        "--unshare-user",
        "--unshare-pid",
        "--unshare-net",
        "--unshare-ipc",
        "--unshare-uts",
        "--cap-drop",
        "ALL",
        "--die-with-parent",
        "--new-session",
        "--ro-bind",
        "/usr",
        "/usr",
        "--ro-bind",
        "/bin",
        "/bin",
        "--ro-bind",
        "/lib",
        "/lib",
        "--ro-bind-try",
        "/lib64",
        "/lib64",
        "--ro-bind-try",
        "/sbin",
        "/sbin",
        "--dir",
        "/etc",
        "--ro-bind-try",
        "/etc/ld.so.cache",
        "/etc/ld.so.cache",
        "--ro-bind-try",
        "/etc/localtime",
        "/etc/localtime",
        "--dev",
        "/dev",
        // Docker内のnested proc mountは権限を要するため、host PIDを見せない空ディレクトリにします。
        "--dir",
        "/proc",
        "--tmpfs",
        "/tmp",
        "--bind",
        workspacePath,
        SANDBOX_WORKSPACE_PATH,
        "--chdir",
        SANDBOX_WORKSPACE_PATH,
        "--clearenv",
        "--setenv",
        "PATH",
        "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "--setenv",
        "HOME",
        SANDBOX_WORKSPACE_PATH,
        "--setenv",
        "XDG_CACHE_HOME",
        `${SANDBOX_WORKSPACE_PATH}/.cache`,
        "--setenv",
        "TMPDIR",
        "/tmp",
        "--setenv",
        "LANG",
        "C.UTF-8",
        "--setenv",
        "LC_ALL",
        "C.UTF-8",
        "--",
        ...sandboxCommand,
    ];
}
