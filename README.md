# 人类真实需求库 · Human Needs

> 一个开放、匿名、可被任何人使用的**全人类社会真实需求**收集项目。
> An open, anonymous, public-domain collection of **real needs from people everywhere**.

很多产品、政策、公益项目失败，是因为它们解决的是"想象中的需求"。这个仓库只做一件事：**把真实的人遇到的真实问题记录下来**，让开发者、研究者、创业者、公益组织、政策制定者都能从中找到值得解决的问题。

## 怎么提交一条需求 / How to submit

1. 点击 **[Issues → New issue → 提交一条需求](../../issues/new/choose)**
2. 按表单填写：你（或你观察到的人）遇到了什么问题、多痛、多频繁、现在怎么凑合
3. 提交即可。机器人会自动打标签，数据每天汇总到 [`data/needs.json`](data/needs.json)

不会用 GitHub？可以把需求发给任何一位贡献者代为提交。

**写好一条需求的诀窍：** 描述*问题*，而不是*解决方案*。
- ❌ "需要一个帮老人挂号的 App"
- ✅ "我妈 70 岁，医院只能线上挂号，她不会用手机，每次都要我请假回去帮她挂"

## 浏览需求 / Browse

| 方式 | 链接 |
|---|---|
| 按领域筛选 | [Labels](../../labels) — `area:健康` `area:教育` … |
| 最受认同（👍 最多） | [按 👍 排序](../../issues?q=is%3Aissue+label%3Aneed+sort%3Areactions-%2B1-desc) |
| 机器可读数据 | [`data/needs.json`](data/needs.json) · 统计 [`data/STATS.md`](data/STATS.md) |

**给你也有的需求点 👍**——这是衡量一个需求有多普遍的最简单方式。在评论里补充你的情况更好。

## 原则 / Principles

1. **真实优先**：第一手经历 > 亲眼观察 > 转述。表单会让你标注来源。
2. **问题优先**：记录痛点和场景，解决方案只是可选补充。
3. **匿名与隐私**：不要写真实姓名、电话、住址、身份证号等。详见 [PRIVACY.md](PRIVACY.md)。
4. **全人类**：任何国家、任何语言、任何群体都欢迎。中英文之外的语言也可以直接写。
5. **开放共享**：所有需求数据以 [CC0](LICENSE-DATA) 公有领域发布，任何人可以免费使用，包括商用。

## 项目结构 / Structure

```
.github/ISSUE_TEMPLATE/need.yml   需求提交表单
.github/workflows/                自动打标签、每日导出
scripts/export_needs.py           把 Issues 导出为 JSON + 统计
scripts/setup_labels.sh           初始化标签
data/needs.json                   全部需求（自动生成）
data/STATS.md                     统计概览（自动生成）
docs/schema.md                    数据字段说明
```

## 参与 / Contribute

见 [CONTRIBUTING.md](CONTRIBUTING.md)：提交需求、整理去重、翻译、做数据分析、或者——**直接去解决其中一个需求**，然后在 issue 下留言告诉大家。

## 许可 / License

- 需求数据（Issues 内容与 `data/`）：[CC0 1.0](LICENSE-DATA)
- 代码（`scripts/`、`.github/`）：[MIT](LICENSE)
