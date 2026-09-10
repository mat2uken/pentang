import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env["PREVIEW_URL"] ?? "http://127.0.0.1:4173/";

export default defineConfig({
  testDir: "./docs/verification",
  timeout: 60000,
  fullyParallel: false,
  use: {
    baseURL,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
    },
  ],
});
