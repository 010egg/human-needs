# 数据字段 / Data schema

每日由 [`scripts/export_needs.py`](../scripts/export_needs.py) 从 Issues 生成：

- `data/needs.json` — 全部需求（数组），字段见下表
- `data/needs.csv` — 同样的数据，扁平表格（UTF-8 BOM，Excel 可直接打开；不含 `labels` 及原始下拉文本）
- `data/STATS.md` — 统计概览

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | int | Issue 编号 |
| `title` | string | 标题（已去掉 `[需求]` 前缀） |
| `url` | string | Issue 链接 |
| `state` | `open`/`closed` | closed 通常表示重复或已有方案 |
| `status` | string | `status:` 标签的值：`待整理` `已整理` `有人在做` `已有方案`，无则为空 |
| `duplicate` | bool | 是否被标为重复。做统计时请排除 `true` |
| `created_at` | ISO 时间 | 提交时间 |
| `updated_at` | ISO 时间 | 最后更新时间 |
| `upvotes` | int | 👍 数量，衡量普遍程度 |
| `comments` | int | 评论数 |
| `labels` | string[] | 全部标签 |
| `problem` | string | 问题描述 |
| `who` | string | 需求人群 |
| `area` | string | 领域（中文），如 `健康医疗` |
| `area_en` | string | 领域（英文），如 `Health` |
| `workaround` | string | 当前替代方案 |
| `severity` | int 1–5 \| null | 痛苦程度 |
| `frequency` | string | 发生频率（表单原文） |
| `frequency_key` | enum | `daily` `weekly` `monthly` `yearly` `rare` 或空 |
| `willingness_to_pay` | string | 付费意愿（表单原文） |
| `willingness_to_pay_key` | enum | `none` `little` `moderate` `high` `unsure` 或空 |
| `region` | string | 国家/地区，自由文本，常见格式 `国家·省` |
| `source` | string | 信息来源（表单原文） |
| `source_key` | enum | `firsthand`（亲历）`observed`（观察）`hearsay`（转述）或空 |
| `extra` | string | 补充 |

未填写的可选字段为空字符串。分析时建议使用 `*_key` 字段，它们不受表单文案修改影响。

## 本地导出 / Local export

```bash
GITHUB_TOKEN=... REPO=010egg/human-needs python scripts/export_needs.py
python scripts/export_needs.py --from-file issues.json --out /tmp/out   # 离线，从 GitHub API 原始 JSON
```
