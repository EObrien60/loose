import { test, expect, type ConsoleMessage } from "@playwright/test";

// A unique identity per run so reused (in-memory) servers don't collide on email.
const uniq = () => Math.random().toString(36).slice(2, 10);

test("register, land in workspace, send a message — with no WS flood", async ({ page }) => {
  // Capture any "rate limited" WS errors the client logs. Before the markRead render-loop
  // fix these streamed continuously; a healthy client produces zero.
  const rateLimited: string[] = [];
  page.on("console", (msg: ConsoleMessage) => {
    const text = msg.text();
    if (/rate limited/i.test(text)) rateLimited.push(text);
  });

  await page.goto("/");

  // Switch to the register form and create an account.
  await page.getByRole("link", { name: "Register" }).click();
  await page.getByPlaceholder("Display name").fill("Playwright User");
  await page.getByPlaceholder("Email").fill(`pw-${uniq()}@example.com`);
  await page.getByPlaceholder("Password").fill("password123");
  await page.getByRole("button", { name: "Register" }).click();

  // Seeded channels prove we reached the workspace.
  await expect(page.getByRole("button", { name: "# general" })).toBeVisible();

  // Send a message and confirm it renders in the timeline.
  const body = `hello ${uniq()}`;
  const composer = page.getByPlaceholder(/^Message/);
  await composer.fill(body);
  await composer.press("Enter");
  await expect(page.getByText(body)).toBeVisible();
  await expect(composer).toHaveValue("");

  // Give any render-loop time to manifest, then assert the socket stayed quiet.
  await page.waitForTimeout(3000);
  expect(rateLimited, `client logged ${rateLimited.length} "rate limited" errors`).toHaveLength(0);
});
