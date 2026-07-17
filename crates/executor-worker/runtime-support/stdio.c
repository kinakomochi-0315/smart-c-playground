#include <stdio.h>

/**
 * 対話実行の標準出力をmain関数より前に無バッファ化します。
 *
 * 改行のないプロンプトもstdin入力を待つ前にPTYへ送信できるよう、
 * 利用可能な最優先のconstructor priorityで設定します。
 */
__attribute__((constructor(101)))
static void configure_interactive_stdout(void)
{
    (void)setvbuf(stdout, NULL, _IONBF, 0);
}
