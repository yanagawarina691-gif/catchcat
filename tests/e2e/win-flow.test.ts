import { expect, test } from '@playwright/test';

/**
 * 通关流程测试：使用 ?e2e=1 本地测试模式（仅 localhost/127.0.0.1 生效），
 * 该模式下猫固定出现在视野正中央、第三只不再逃跑，从而保证点击行为可断言。
 */
test('catches three cats and reaches the win screen', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('/?e2e=1');
  await expect(page.getByRole('heading', { name: '寻喵大作战' })).toBeVisible();

  const canvas = page.locator('#gameCanvas');
  await expect(canvas).toBeVisible();

  await page.getByRole('button', { name: '开找' }).click();
  await expect(page.getByText('找猫中 0/3')).toBeVisible({ timeout: 5_000 });

  const box = (await canvas.boundingBox())!;
  for (let round = 1; round <= 3; round += 1) {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.getByText(`第${round}次`)).toBeVisible({ timeout: 4_000 });
    // 等待 fluff 动效结束、下一只猫生成
    await page.waitForTimeout(1_500);
  }

  await expect(page.getByRole('heading', { name: '通关啦！' })).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText('你（本次）')).toBeVisible();
  expect(errors).toEqual([]);
});

test('settings persist across a reload', async ({ page }) => {
  await page.goto('/?e2e=1');
  await page.getByRole('button', { name: '游戏设置' }).click();
  const sound = page.locator('#settingSound');
  await sound.uncheck();
  await expect(sound).not.toBeChecked();

  await page.reload();
  await page.getByRole('button', { name: '游戏设置' }).click();
  await expect(page.locator('#settingSound')).not.toBeChecked();
});
