# 参与贡献 / Contributing

## 1. 提交需求
用 [Issue 表单](../../issues/new/choose)。一条 issue 只写一个需求。描述问题和场景，不要只写解决方案。

## 2. 认同与补充
看到你也有的需求，点 👍；在评论里补充你的场景、地区、你试过的办法。这比新开一条重复 issue 更有价值。

## 3. 整理（维护者）
- 新需求带 `status:待整理`，确认分类无误、无隐私信息后改为 `status:已整理`
- 重复的需求：评论 `Duplicate of #N`，打 `duplicate` 标签后关闭
- 含个人信息的内容：编辑删除，必要时整条隐藏。机器人检测到疑似个人信息会打 `隐私待查` 标签并留言，确认处理后手动移除该标签
- 有人在做 / 已有方案：改对应 status 标签，并在评论里附链接

## 4. 用数据
[`data/needs.json`](data/needs.json) 和 [`data/needs.csv`](data/needs.csv) 每天自动更新，字段见 [docs/schema.md](docs/schema.md)。统计时请排除 `duplicate: true` 的条目。欢迎做分析、聚类、可视化，并把结果发到 Discussions。

## 5. 解决需求
最好的贡献是去解决其中一个。做了什么，在对应 issue 下留言，维护者会更新状态。

## 6. 改进代码
网站在 `site/`（纯 HTML/JS，无构建），数据管道在 `scripts/`，只用 Python / Node 标准库。提交 PR 前运行：

```bash
python -m unittest discover tests && node --test tests/*.test.js
```

修改了 Issue 表单的下拉选项，请同步更新 `scripts/export_needs.py` 里的映射表——测试会检查这一点。

## 行为准则
尊重每一位提交者。不嘲笑任何需求"太小"或"太傻"——对当事人来说它是真的。禁止歧视、骚扰、广告刷屏。
