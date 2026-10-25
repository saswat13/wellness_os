import type { NextConfig } from "next";
const config: NextConfig = {
  output: process.env.FORM_STATIC_EXPORT === "1" ? "export" : undefined,
  devIndicators: false,
  allowedDevOrigins: ["127.0.0.1", "localhost", "*.app.github.dev"],
};
export default config;
