import { expect, test } from '@playwright/test';

test('starts the game and exposes settings', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '寻喵大作战' })).toBeVisible();
  await page.getByRole('button', { name: '游戏设置' }).click();
  await expect(page.getByRole('region', { name: '游戏设置' })).toBeVisible();
  await page.getByRole('button', { name: '开找' }).click();
  await expect(page.getByText('找猫中 0/3')).toBeVisible({ timeout: 5_000 });
  expect(errors).toEqual([]);
});
