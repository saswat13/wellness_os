import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "FORM · Fitness & nutrition",
  description:
    "Your daily practice: workouts, nutrition and progress. A local prototype.",
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      {/* Extensions may add body attributes before hydration. Keep this escape
          hatch on body only; app descendants retain normal hydration checks. */}
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
