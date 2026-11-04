# 崽崽打卡站 · 宠物护理提醒小程序

记录宠物每月驱虫、体检、更换滤芯/干燥剂等周期任务，到期通过微信订阅消息推送提醒。

## 技术栈

- **小程序端** `miniprogram/`：微信原生小程序（无框架），奶油马卡龙设计风格
- **后端** `backend/`：Python FastAPI + APScheduler + PyMySQL，支持 SQLite（本地调试）/ MySQL 双驱动
- **数据库**：MySQL（生产），建表见 `backend/schema.sql`

## 功能

- 微信快捷登录（HMAC 自签 token）
- 多宠物档案管理（8 种常见家养宠物 + emoji 头像）
- 护理任务：周期间隔、到期分组、提前完成/补记、同日幂等、撤销
- 一键套用标准护理模板（按物种生成驱虫/疫苗/体检等）
- 订阅消息提醒：任务级提醒时间（8/12/20 点）+ 提前几天，发送结果留痕（notify_logs），配额可视化
- 体重记录 + 近 8 次趋势（纯记录，无健康判断）
- 打卡历史：宠物/类型双筛选，改日期、撤销

## 目录结构

```
petcare-reminder/
├── miniprogram/          # 小程序前端
│   ├── pages/            # index 任务 / pets 宠物 / history 记录 / profile 我的
│   ├── templates/        # 自定义弹框模板
│   └── utils/            # api 请求（多地址自动探测）、ui 弹框工具
└── backend/              # FastAPI 后端
    ├── app.py            # 全部 API + 定时推送任务
    ├── database.py       # SQLite/MySQL 双驱动 + 连接池
    ├── schema.sql        # 建表语句
    ├── migrate_v2.py     # 数据库迁移（幂等）
    └── trigger_notify.py # 手动触发提醒（诊断用）
```

## 本地运行

后端（Python 3.10+）：

```bash
cd backend
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt   # Linux/Mac 用 pip3
cp .env.example .env                            # 填入你的微信 AppID/AppSecret、数据库配置
.venv/Scripts/python -m uvicorn app:app --host 0.0.0.0 --port 8000
```

小程序端：用微信开发者工具打开项目根目录（`project.config.json` 已配置 `miniprogramRoot`），在 `utils/api.js` 中配置后端地址。

## 敏感信息说明

所有密钥（AppSecret、数据库密码、token 密钥）一律通过 `backend/.env` 注入，`.env` 已被 `.gitignore` 排除，不会进入版本库。字段说明见 `backend/.env.example`。
