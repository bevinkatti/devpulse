import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "DevPulse — Webhook operations",
  description: "Monitor and operate webhook delivery from one place.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
