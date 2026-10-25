import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests-cloud",
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  use: {
    baseURL: "http://127.0.0.1:3001",
    viewport: { width: 390, height: 844 },
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "npm run start",
      url: "http://127.0.0.1:3000",
      reuseExistingServer: !process.env.CI,
      timeout: 120000,
    },
    {
      command:
        "PYTHONPATH=backend backend/.venv/bin/python backend/local/server.py --fake-auth",
      url: "http://127.0.0.1:3001",
      reuseExistingServer: false,
      timeout: 30000,
      env: { FORM_LOCAL_TEST_KEY: "local-test-control-only" },
    },
  ],
});
