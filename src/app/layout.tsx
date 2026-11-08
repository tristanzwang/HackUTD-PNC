import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "3D Fluid Simulation",
  description: "Splash around in an interactive 3D fluid simulation.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // Browser extensions (e.g. custom cursors) inject attributes onto <html>/<body>
    // before hydration; suppress the resulting harmless mismatch warning.
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
