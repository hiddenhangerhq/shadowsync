import type { Metadata, Viewport } from "next";
import "./globals.css";
import { THEME_SCRIPT } from "@/lib/theme";
import { currentUser, getServices } from "@/lib/data";
import ThemeSync from "@/components/ThemeSync";
import SwRegister from "@/components/SwRegister";

export const metadata: Metadata = {
  title: "Shadow Sync",
  description: "Inventory, listings and sales for resellers.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Shadow Sync", statusBarStyle: "black-translucent" },
  icons: { icon: "/icons/icon-192.png", apple: "/icons/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0a0f12" },
    { media: "(prefers-color-scheme: light)", color: "#f1f6f4" },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  const theme = user ? (await (await getServices()).store.profile.get())?.theme : undefined;
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Runs before first paint so the saved theme never flashes. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        {children}
        {theme && <ThemeSync theme={theme} />}
        <SwRegister />
      </body>
    </html>
  );
}
