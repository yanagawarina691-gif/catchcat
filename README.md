# 寻喵大作战 / Catchcat

一款为手机浏览器设计的 360° 全景找猫小游戏。转动手机或拖动画面寻找藏起来的小猫，在倒计时结束前点击抓住三只即可通关。

## 在线试玩 / Live demo

GitHub Pages 启用后，地址为：

`https://<your-github-name>.github.io/catchcat/`

> 陀螺仪需要 HTTPS。iPhone/iPad 会在点击“开找”后请求动作与方向访问权限；拒绝后仍可拖动画面游玩。

## 玩法 / How to play

- 转动手机，或在桌面和不支持陀螺仪的设备上拖动画面。
- 点击看到的小猫；点错或超时后，小猫会换一个位置。
- 抓到三只猫即可生成战绩卡片。
- 设置菜单可关闭声音、关闭陀螺仪或减少动态效果。
- 结算页排行榜为明确标注的模拟数据，不是在线排名；最佳成绩仅保存在当前浏览器。

## 技术栈 / Stack

- Vite + TypeScript
- Three.js 全景球体渲染
- DOM/Canvas HUD 与分享卡
- Vitest 单元测试
- Playwright 桌面与移动端冒烟测试
- GitHub Actions + GitHub Pages

## 本地开发 / Development

需要 Node.js 22。

```bash
npm install
npm run dev
```

质量检查：

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
```

## 项目结构

```text
src/
  game/       规则、配置和成绩存储
  render/     Three.js 渲染生命周期
  ui/         DOM 设置与持久化
  main.ts     现有游戏编排层（持续向模块迁移）
public/
  images/     游戏图片
  audio/      背景音乐、音效与来源记录
tests/        单元测试与浏览器测试
```

## 发布

推送到 `main` 后，`Deploy GitHub Pages` 工作流会构建并发布 `dist/`。首次发布前，在仓库的 **Settings → Pages → Build and deployment** 中选择 **GitHub Actions**。

## 素材与许可

图片、音频和代码均按 [MIT License](LICENSE) 发布。音频来源与原始站点记录见 [`public/audio/SOURCES.txt`](public/audio/SOURCES.txt)。

---

Catchcat is a mobile-first 360° hidden-object browser game. Rotate your device or drag the panorama, catch three cats, and share your result. Gyroscope access is optional and the complete game remains playable with pointer input.
