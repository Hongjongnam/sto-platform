import type { Metadata } from "next";
import { Providers } from "../components/providers";
import { Shell } from "../components/shell";
import "./globals.css";

export const metadata: Metadata = {
  title: "토큰증권 운영 콘솔 (데모)",
  description: "증권 토큰의 발행, 결제, 권리행사, 장부 대사를 직접 따라가 보는 데모",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ko" className="h-full antialiased">
      <body className="min-h-full">
        <Providers>
          <Shell>{children}</Shell>
        </Providers>
      </body>
    </html>
  );
}
