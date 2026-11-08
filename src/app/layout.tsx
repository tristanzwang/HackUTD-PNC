import type { Metadata } from "next";
import { Cormorant_Garamond } from "next/font/google";
import "./globals.css";

// The interface's voice: a high-contrast old-style serif, with real italics.
const serif = Cormorant_Garamond({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  style: ["normal", "italic"],
  variable: "--font-cormorant",
  display: "swap",
});

export const metadata: Metadata = {
  title: "3D Graphs",
  description: "Plot and explore interactive 3D graphs.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // Browser extensions (e.g. custom cursors) inject attributes onto <html>/<body>
    // before hydration; suppress the resulting harmless mismatch warning.
    <html lang="en" className={serif.variable} suppressHydrationWarning>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
