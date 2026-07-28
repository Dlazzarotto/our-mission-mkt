import type { Metadata } from "next";
import "./globals.css";
import { AGENCY_NAME, PRODUCT_NAME } from "@/lib/brand";

export const metadata: Metadata = {
  title: `${AGENCY_NAME} — ${PRODUCT_NAME}`,
  description: `${AGENCY_NAME} — gestão de contratos e campanhas de marketing criadas por IA.`,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
