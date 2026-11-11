# 法语阅读练习：公开改编文章

本仓库是法语阅读练习 App 的内容源，只存放**已通过许可与结构校验的改编文章**。原文、抓取与改写流水线在私有仓库 `french-reading-content-private`，不在这里。

## 结构

```text
manifest.json                     ← 月份列表
months/<YYYY-MM>.json             ← 当月文章元数据
articles/<YYYY-MM-DD-slug>.json   ← 每篇一个文件，含正文、题目、中文翻译、来源与许可
scripts/check.mjs                 ← 发布前结构校验
```

App 先拉 `manifest.json`，再按月拉索引，点开文章才拉全文。

## 许可

- 每篇文章的文本按 [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) 发布。
- 每篇 JSON 自带 `source`（原标题、作者、来源链接、原许可、获取日期）、`adaptation`（模型、日期、修改说明、审校人）和 `license`。
- 改编文由语言模型简化改写、另一个模型审校；不是原文，也不代表原作者或来源方背书。
- 本仓库不包含原文；原文只保存在私有仓库。

## 校验

本仓库只存数据并做校验，**不部署、不启用 Pages**。只有 app 仓库有 Pages。

推送 `main` 或开 PR 时，GitHub Actions 先跑 `node --test scripts/lib/validate.test.mjs`，再跑 `node scripts/check.mjs`。校验失败会在 Actions 里标红；app 只应读取通过校验的 `main`。

本地校验：

```powershell
npm test
npm run check
```

App 运行时从 raw 读取：

```text
https://raw.githubusercontent.com/dinayuil/french-reading-content-public/main/
  manifest.json
  months/<YYYY-MM>.json
  articles/<id>.json
```

内容更新推送到 `main` 后，app 下一次请求就能拿到，不需要重新发布 app。
