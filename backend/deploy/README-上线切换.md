# 备案通过后 —— 上线切换手册

> 目标：备案通过当天，30 分钟内把小程序从「本地后端 + http IP」切到「服务器 + https 域名」。
> 涉及文件都在 `backend/deploy/`。

## 前置清单（切换前确认）

- [ ] 域名 ICP 备案通过（工信部短信/邮件通知）
- [ ] 小程序备案通过（mp 后台显示"备案成功"）
- [ ] 小程序隐私保护指引已生效（后台左下角账号设置 → 基础设置 → 服务内容声明）

## 第一步：申请免费证书（约 10 分钟）

1. 腾讯云控制台 → 搜索「SSL 证书」→ 申请免费证书（TrustAsia DV）
2. 域名填 `zaizaidaka.site`，验证方式选「自动 DNS 验证」（域名在腾讯云解析，几分钟通过）
3. 通过后下载证书，格式选 **Nginx**，得到压缩包，解压出两个文件：
   - `zaizaidaka.site_bundle.crt`
   - `zaizaidaka.site.key`

## 第二步：上传证书并执行部署脚本（约 2 分钟）

本机执行（或用任意 SFTP 工具上传）：

```bash
scp backend/deploy/nginx-zaizaidaka.conf backend/deploy/setup-https.sh root@152.136.58.30:/opt/petcare/
scp <证书目录>/zaizaidaka.site_bundle.crt <证书目录>/zaizaidaka.site.key root@152.136.58.30:/root/
```

服务器执行：

```bash
cd /opt/petcare
bash setup-https.sh /root/zaizaidaka.site_bundle.crt /root/zaizaidaka.site.key
```

脚本会自动：装 nginx → 校验证书 → 装 443 站点（反代 127.0.0.1:8001）→ 语法检查 → 重载。

## 第三步：放行 80/443 端口

腾讯云控制台 → 轻量/CVM → 防火墙（安全组）→ 放行 TCP 80、443。

## 第三步半：同步 uploads 目录（⚠️ 必做，否则历史头像全部 404）

头像等上传文件存在后端 `backend/uploads/`，**本地和服务器各有一份、互不同步**。
开发期在本地后端上传的文件只存在电脑上，切换到服务器后端后会读取失败（404 → 头像显示回落 emoji）。

切换前把本地新增的文件补传到服务器：

```bash
scp petcare-reminder/backend/uploads/* root@152.136.58.30:/opt/petcare/backend/uploads/
```

> 2026-11-09 教训：用户在服务器后端时期上传的头像 u1_1794201109.jpg 只存在服务器，
> 切回本地后端后 404，数据库头像记录指向了不存在的文件（已在库中重置为 emoji）。
> 双向都会发生：本地传的切服务器要补传，服务器传的回本地也要拉回。

验证（本机）：

```bash
curl -I https://zaizaidaka.site/api/ping     # 期望 HTTP/2 200
```

## 第三步半之二：环境区分 prod / uat（2026-11-12 起）

| 环境 | 后端位置 | APP_ENV | 数据库 | 上传目录 | 小程序版本路由 |
|---|---|---|---|---|---|
| **uat 测试** | 本机 8000（或以后 uat.zaizaidaka.site） | `uat` | 本地 SQLite `petcare_uat.db`（云库 petcare_uat 已建好备用） | `uploads/uat/` | develop（开发工具/真机调试） |
| **prod 生产** | 服务器 8001 → https://zaizaidaka.site | `prod` | `petcare` | `uploads/prod/`（旧文件在根目录，读取兜底） | release（正式版）；体验版 trial 先打 uat 域名、不通回落 prod |

要点：
- 后端按 `APP_ENV` 环境变量决定上传落盘子目录；`/api/ping` 返回 `env` 字段可确认连的是哪个环境
- 数据隔离靠 `MYSQL_DB`：本地 `.env.uat`（petcare_uat） vs 服务器 `.env.prod`（petcare）；两套文件已在 backend/ 目录，密码相同不要提交 git
- uat 库建库脚本：`deploy/create-uat-db.sql`（root 执行一次）
- 2026-11-12 实施记录：云 MySQL 已建 petcare_uat（root 容器内执行，petapp 已授权）。⚠️ 发现勒索攻击残留库 RECOVER_YOUR_DATA（数据未受损，已删除）——3306 曾对公网开放被扫描。已删除防火墙 3306 规则，本地后端改用 SQLite uat，云 MySQL 仅服务器内部访问。容器 MYSQL_ROOT_PASSWORD 环境变量与实际 root 密码不一致（实际密码请自行保管，勿入库）
- 前端 `utils/api.js` 按 `wx.getAccountInfoSync().miniProgram.envVersion` 自动路由，无需手动切换
- uat 子域名 `uat.zaizaidaka.site` 随主域名备案生效，无需单独备案；部署时在 nginx 加一个 server 块反代 uat 后端端口即可

## 第四步：切换前端（已自动化，仅需配合法域名）

前端 `miniprogram/utils/api.js` 已按小程序版本自动路由（develop→本机 uat、trial→uat 域名、release→prod 域名），
无需改代码。备案通过后只需在 mp 后台 → 开发与服务 → 开发设置 → **服务器域名** → request 合法域名添加：

```
https://zaizaidaka.site
https://uat.zaizaidaka.site
```

之后微信开发者工具重新编译，手机预览**不再需要开调试模式**。

## 第五步：收尾安全（切换完成后立刻做）

- [ ] 服务器关闭 3306 对公网：`docker update --restart=no mysql8` 不是关容器，而是改端口绑定：
      改用 `docker stop mysql8 && docker rm mysql8 && docker run ... -p 127.0.0.1:3306:3306 ...`（数据在 `mysql_data` 卷，安全），或直接在腾讯云安全组删除 3306 入站规则（**推荐，零风险**）
- [ ] 删除安全组里已不用的 8001 直连规则（走 https 后不再需要）
- [ ] `trigger_notify.py` 等本地脚本如需连库，走 SSH 隧道

## 提审材料

- **头像**：`designs/appicon-zaizai-1024.png`（300px 预览版 `appicon-zaizai-300.png`）
- **简介**（4-120 字，可直接用）：

> 崽崽打卡站，给毛孩子的护理备忘录。记录驱虫、疫苗、体检、洗澡等周期任务，到期自动提醒；支持多宠物管理、体重记录与打卡历史。数据仅保存在你自己的账号下，不公开、不分享。

- **提审时勾选**：「采集用户隐私」相关选项与已通过的隐私指引保持一致（仅用户信息 + 用户填写的信息）
- **类目**：工具 → 备忘录
- **提审前自查红线**：无支付、无医疗建议、无公开评论、无诱导分享 ✅
