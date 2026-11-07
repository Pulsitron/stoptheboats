import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Stop the Boats — Operation Tidebreak",
  description:
    "Hold the coastline in Operation Tidebreak: cinematic water, attack waves, field upgrades, artillery support and global rankings.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
