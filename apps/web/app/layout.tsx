import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
    title: "✨かしこい✨C言語実行環境",
    description: "補完・実行前診断・対話入出力に対応したC言語実行環境",
};

export const viewport: Viewport = {
    colorScheme: "light dark",
    width: "device-width",
    initialScale: 1,
};

interface RootLayoutProps {
    children: ReactNode;
}

/**
 * アプリケーション全体の言語・メタデータ・グローバルスタイルを設定します。
 */
export default function RootLayout({ children }: RootLayoutProps) {
    return (
        <html lang="ja" className="size-full bg-background text-foreground">
            <body className="size-full overflow-hidden bg-background font-sans text-sm text-foreground [text-rendering:optimizeLegibility]">
                {children}
            </body>
        </html>
    );
}
