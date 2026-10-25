import { test as base, expect } from "@playwright/test";
export const test = base.extend<{
  auditConsole: void;
  expectedApiStatuses: number[];
}>({
  expectedApiStatuses: [[], { option: true }],
  auditConsole: [
    async ({ page, expectedApiStatuses }, use) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") {
          const text = message.text();
          const status = Number(text.match(/status of (\d{3})/)?.[1]);
          const url = message.location().url;
          // Expected negative auth/conflict tests may allow only matching API resource errors.
          if (
            expectedApiStatuses.includes(status) &&
            /\/(api\/v1\/|auth\/session)/.test(url)
          )
            return;
          errors.push(text);
        }
      });
      await use();
      expect(errors, "No unhandled browser errors or console errors").toEqual(
        [],
      );
    },
    { auto: true },
  ],
});
