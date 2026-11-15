# 数据字段 / Data schema

`data/needs.json` 是一个数组，每个元素：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | int | Issue 编号 |
| `title` | string | 标题 |
| `url` | string | Issue 链接 |
| `state` | `open`/`closed` | closed 通常表示重复或已有方案 |
| `created_at` | ISO 时间 | 提交时间 |
| `upvotes` | int | 👍 数量，衡量普遍程度 |
| `comments` | int | 评论数 |
| `labels` | string[] | 标签（领域、痛度、来源、状态） |
| `problem` | string | 问题描述 |
| `who` | string | 需求人群 |
| `area` | string | 领域 |
| `workaround` | string | 当前替代方案 |
| `severity` | int 1–5 | 痛苦程度 |
| `frequency` | string | 发生频率 |
| `willingness_to_pay` | string | 付费意愿 |
| `region` | string | 国家/地区 |
| `source` | string | 亲历 / 观察 / 转述 |
| `extra` | string | 补充 |
