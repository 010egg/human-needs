# 需求发现方法 / Discovery method

目标不是给出一份"去哪儿搜"的数据源清单，而是一套**能持续运行、能被数据推翻**的需求发现方法。分四层，每层在代码里都有对应的位置，在[看板](https://010egg.github.io/human-needs/)上都有对应的面板。

## 1. 能力层：持续监控，而不是偶尔调研

数据源按"它能证明什么"分层，而不是按平台分（配置在 [`discover/config.json`](../discover/config.json)）：

| 层 | 证明什么 | 数据源 | 状态 |
|---|---|---|---|
| 💰 有钱在动 `money` | 已经有人在为这个问题花钱 | HN "Who is hiring" 招聘帖；Meta 广告库（欧盟投放的广告） | 招聘默认开启；广告库需 `META_AD_LIBRARY_TOKEN` |
| 🗣 一手抱怨 `firsthand` | 真实的人在真实地受苦 | Hacker News、V2EX、Reddit；你自己导出的群聊/社区记录（`INBOX_DIR`，仅本地运行） | HN、V2EX 默认开启；Reddit 需 OAuth 凭据 |
| 🔇 被删除 `suppressed` | 主流平台不让说的需求 | Telegram 公开频道（网页预览，无需登录） | 默认关闭，频道名单由你决定 |

流水线每 6 小时跑一次（[`discover.yml`](../.github/workflows/discover.yml)）：
采集 → 关键词初筛（省钱）→ Claude 审核与打分 → 写入语料库 → 尺子门槛 → 建 issue 或给已有 issue 追加证据。
每次运行的漏斗与每个数据源的成败都写入 `data/discovery/runs.jsonl`，看板的"数据源健康"面板会标出停摆或连续失败的源。

## 2. 判断层：一把尺子，不被热闹骗

我们不关心"什么话题火"，只关心"什么需求真的有人付过代价"。每条信号四个指标：

| 指标 | 谁来判 | 0 | 3 |
|---|---|---|---|
| **重复** | 系统计数：同一 `need_key` 的独立 URL 数，**不由模型判断** | 只出现一次 | ≥ 4 次独立目击 |
| **代价** | 模型，依据原帖证据 | 没提 | 健康、安全、生计或大额金钱 |
| **不满** | 模型，依据原帖证据 | 没提现有方案 | 试过多个方案都不行，或唯一方案用不起/用不了 |
| **支付意愿** | 模型，依据原帖证据 | 无信号 | 已有企业为此花钱（招聘、广告、付费服务）或本人正在大额付费 |

**尺子分** = 代价 + 不满 + 支付意愿 + min(3, 重复 − 1)，满分 12。低于 `min_ruler_score`（默认 4）的只进语料库、不建 issue。
每个分数都附一句改写过的证据，写在 issue 和看板详情里，方便人工复核模型有没有打错。实现：[`discover/ruler.py`](../discover/ruler.py)、[`site/core.js`](../site/core.js)（两者由测试保证一致）。

## 3. 验证层：给数字，并允许被数字打脸

- **语料库保存所有审核过的信号，包括被判为"不是需求"的**（`data/discovery/corpus/YYYY-MM.jsonl`）。没有分母就算不出"X 占 Y%"。
- 只保存模型改写后的结构化记录 + 原帖链接，**不保存原文**（版权与隐私）。
- 判断写成可检验的假设，放在 [`data/discovery/hypotheses.json`](../data/discovery/hypotheses.json)：

```json
{"id": "care-share", "statement": "护理/照护相关需求占全部真实需求信号的 5% 以上",
 "of": {"is_need": true}, "subset": {"keywords": ["护理", "caregiver"]},
 "op": ">", "threshold": 0.05, "min_n": 200}
```

看板实时计算比例和 Wilson 95% 区间：整个区间都在阈值的主张一侧 → **支持**；整个区间都在另一侧 → **被推翻**；跨过阈值 → **尚无定论**；样本不足 `min_n` → **样本不足**。每条假设下面有 12 周的裁决轨迹，数据改变主意时一眼可见。

已知偏差（请在解读数字时记住）：
- 分母是"通过关键词初筛并被模型审过的帖子"，不是全部互联网。初筛词表决定了你能看见什么。
- 各数据源的人群差异很大（HN 偏英语技术人群，V2EX 偏中文技术人群）。比较地区或领域时，先按数据层/来源切开看。
- 地区只在原帖明确提及时记录，大量信号没有地区。看板地图下方会写出未定位的比例。

## 4. 商业层：需求成立，不等于你能做

模型从每条信号里抽取**原帖提到的现有方案，以及它为什么不够好**；招聘帖和广告背后的机构被标为"出钱信号"。看板"同行格局"面板按方案聚合：被提到多少次、有多少出钱信号、用户卡在哪、对应哪些需求簇。点一个方案，整个看板就只看与它相关的信号。

这是从用户抱怨里看到的同行格局，**不是**完整的竞品调研：没被抱怨的产品不会出现，融资和市场份额也不在这里。

## 运行

仓库 Settings → Secrets and variables → Actions 添加：

| Secret | 必需 | 用途 |
|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ | 审核与打分（模型见 `discover/config.json`） |
| `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` | 可选 | Reddit 数据源（在 reddit.com/prefs/apps 建一个 script 应用） |
| `META_AD_LIBRARY_TOKEN` | 可选 | Meta 广告库 |

先手动运行 Actions → Discover needs（默认 dry run，只出报告不建 issue），看报告里的判断是否靠谱，再让定时任务正式运行。
本地：`pip install -r discover/requirements.txt && python -m discover.run --dry-run`。
