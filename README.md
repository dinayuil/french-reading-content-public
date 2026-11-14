# 法语阅读练习：公开改编文章

本仓库是法语阅读练习 App 的内容源，只存放**已通过许可与结构校验的改编文章**。原文、抓取与改写流水线在私有仓库 `french-reading-content-private`，不在这里。

## 结构

```text
manifest.json                     ← 日期列表
days/<YYYY-MM-DD>.json            ← 当日文章元数据
articles/<YYYY-MM-DD-slug>.json   ← 每篇一个文件，含正文、题目、中文翻译、来源与许可
images/<article-id>-<hash>.jpg    ← 可选的、独立核验许可的配图（或 .png）
scripts/check.mjs                 ← 发布前结构校验
```

App 先拉 `manifest.json`，再按日拉索引，点开文章才拉全文。日索引的 `date` 必须与文件名、条目 `date` 和文章元数据一致；每篇文章恰好被一个日索引引用。

## 许可

- 每篇文章的文本按 [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) 发布。
- 每篇 JSON 自带 `source`（原标题、作者、来源链接、原许可、获取日期）、`adaptation`（模型、日期、修改说明、审校人）和 `license`。
- `source.authors` 记录文字原作者；如法语来源由他人翻译，`source.translators` 可记录法语译者。该字段可缺省，存在时必须是非空字符串组成的非空数组。摄影作者与图片许可不混入文字作者或摘要。
- 改编文由语言模型简化改写、另一个模型审校；不是原文，也不代表原作者或来源方背书。
- 配图保留自身许可，不能按正文许可重新标注。图片元数据单独记录摄影作者、Commons 文件页及版本、实际许可链接、处理说明和文件哈希；只有实际采用的图片才展示图片署名。
- 本仓库不包含原文；原文只保存在私有仓库。

## 校验

### 练习题的双语字段

- `questions[].explanation`：可选的非空法语解析，解释原句证据如何支持答案。
- `translations.zh.questions`：保留原格式，仍为问题 id 到中文解析的字符串映射。
- `translations.zh.questionTexts`：可选的问题 id 映射，每项为 `{ "prompt": "中文题干", "options": ["中文选项1", "中文选项2", "中文选项3", "中文选项4"] }`。存在时必须覆盖且仅覆盖文章全部问题，选项恰好四个、非空且唯一，顺序逐项对应法语选项，不另设答案索引。
- 旧文章缺少新增字段仍合法；字段存在但不完整或类型错误会被拒绝。新流水线对新生成内容要求上述新增字段齐全。应用以独立的翻译开关显示中文内容，UI 语言不改变内容语言。

### 可选配图

文章可带一个 `image` 对象，字段为 `path`、`alt`、`author`、`sourceUrl`、`license`、`licenseUrl`、`changes`、`width`、`height`、`byteLength`、`sha256`、`fileRevisionId`、`retrievedAt`。路径为 `images/<article-id>-<sha256前12位>.jpg` 或 `.png`；不接受任意外部图片地址或路径穿越。

接收 Commons 中权利结构明确的 CC0 1.0、CC BY / CC BY-SA 2.0、2.5、3.0、4.0 图片，以及文件自身有明确公有领域声明的图片。后者的 `license` 为 `Public domain`，`licenseUrl` 必须为 `https://creativecommons.org/publicdomain/mark/1.0/`；该链接表示公有领域状态，不是 CC0 重授权。每图不超过 1 MiB、最长边不超过 1600px。校验既检查元数据，也检查引用文件存在、字节长度、文件签名、真实尺寸与 SHA256。无图文章继续合法，已有但错误的图片声明不得发布。

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
  days/<YYYY-MM-DD>.json
  articles/<id>.json
```

内容更新推送到 `main` 后，app 下一次请求就能拿到，不需要重新发布 app。
