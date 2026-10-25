import { defineConfig } from "@playwright/test";
import base from "./playwright.cloud.config";

export default defineConfig({
  ...base,
  testDir: "./tests-catalog",
  webServer: [
    {
      command: "npm run start",
      url: "http://127.0.0.1:3000",
      timeout: 120000,
    },
    {
      command:
        "PYTHONPATH=backend backend/.venv/bin/python backend/local/server.py --fake-auth --catalog-bundle backend/catalog/launch-v1/catalog.json",
      url: "http://127.0.0.1:3001",
      timeout: 30000,
    },
  ],
});
