#!/usr/bin/env bash
# 初始化仓库标签。用法: REPO=owner/name bash scripts/setup_labels.sh
set -euo pipefail
REPO=${REPO:-010egg/human-needs}
mk() { gh label create "$1" --color "$2" --description "${3:-}" --repo "$REPO" --force >/dev/null; echo "  $1"; }
mk need 0E8A16 "一条真实需求"
mk "status:待整理" FBCA04 "新提交，等待整理"
mk "status:已整理" C2E0C6 "格式和分类已确认"
mk "status:有人在做" 1D76DB "有人正在尝试解决，见评论"
mk "status:已有方案" 5319E7 "已有可用的解决方案，见评论"
mk duplicate CFD3D7 "与其他需求重复"
for a in 健康医疗 教育学习 工作收入 住房居住 食物饮水 交通出行 金融财务 法律权益 家庭养育 养老 无障碍 心理与社交 环境能源 公共服务 数字工具 安全 其他; do
  mk "area:$a" BFD4F2
done
for s in 1 2 3 4 5; do
  c=(FEF2C0 FBCA04 F9A825 E4572E B60205); mk "痛度:$s" "${c[$((s-1))]}"
done
mk "来源:亲历" 0B6E4F "第一手经历"
mk "来源:观察" 4C9F70 "亲眼观察"
mk "来源:转述" A7C4A0 "听说或网络"
