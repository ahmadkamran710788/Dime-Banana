import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Nano Banana Studio",
  description: "AI image generation and editing with Nano Banana Pro & Nano Banana 2",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      {/* suppressHydrationWarning: browser extensions (e.g. ColorZilla) inject
          attributes into <body> before React hydrates, causing false mismatches */}
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
