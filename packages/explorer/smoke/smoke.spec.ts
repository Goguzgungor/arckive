import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { BUSY, SWAP_TX } from '../test/fixture/rows.ts';

const SHOTS = fileURLToPath(new URL('./screenshots/', import.meta.url));
mkdirSync(SHOTS, { recursive: true });

test('the tape fills and flows', async ({ page }) => {
  await page.goto('/');
  const first = page.locator('.tape .row').first();
  await expect(first).toBeVisible();
  const href = await first.getAttribute('href');
  await expect.poll(() => page.locator('.tape .row').first().getAttribute('href'), { timeout: 15_000 }).not.toBe(href);
  await expect(page.locator('h1')).toContainText('In the last minute');
});

test('hovering the tape pauses it and leaving drains it', async ({ page }) => {
  await page.goto('/');
  const tape = page.locator('.tape');
  await expect(tape.locator('.row').first()).toBeVisible();
  await tape.hover();
  const held = await tape.locator('.row').first().getAttribute('href');
  await page.waitForTimeout(3000);
  expect(await tape.locator('.row').first().getAttribute('href')).toBe(held);
  await expect(page.locator('.waiting')).toBeVisible();
  await page.mouse.move(5, 5);
  await expect.poll(() => tape.locator('.row').first().getAttribute('href'), { timeout: 10_000 }).not.toBe(held);
});

test('a row opens its transaction', async ({ page }) => {
  await page.goto('/');
  await page.locator('.tape .row').first().click();
  await expect(page).toHaveURL(/\/tx\/0x[0-9a-f]{64}$/);
  await expect(page.locator('h1')).toBeVisible();
  await expect(page.locator('.events .ev').first()).toBeVisible();
});

test('search routes both ways and hints otherwise', async ({ page }) => {
  await page.goto('/');
  const q = page.locator('input[name=q]');
  await q.fill(SWAP_TX.toUpperCase().replace('0X', '0x'));
  await q.press('Enter');
  await expect(page).toHaveURL(`/tx/${SWAP_TX}`);
  await expect(page.locator('h1')).toContainText('swapped');
  await expect(page.locator('.swapbox')).toContainText('476.93');
  await page.locator('input[name=q]').fill(BUSY);
  await page.locator('input[name=q]').press('Enter');
  await expect(page).toHaveURL(`/address/${BUSY}`);
  await expect(page.locator('.stats')).toBeVisible();
  await page.locator('input[name=q]').fill('hello');
  await page.locator('input[name=q]').press('Enter');
  await expect(page.locator('.search .hint')).toBeVisible();
});

for (const [w, h] of [[1440, 1000], [390, 844]] as const) {
  test(`pages render at ${w} px without sideways scrolling`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    for (const [name, path] of [['home', '/'], ['tx', `/tx/${SWAP_TX}`], ['address', `/address/${BUSY}`]] as const) {
      await page.goto(path);
      await expect(page.locator('h1')).toBeVisible();
      if (name === 'home') await expect(page.locator('.tape .row').first()).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `${name} scrolls sideways at ${w} px`).toBeLessThanOrEqual(0);
      if (name === 'home' && w < 520) await expect(page.locator('.tape .row .who').first()).toBeHidden();
      await page.screenshot({ path: `${SHOTS}${name}-${w}.png`, fullPage: true });
    }
  });
}
