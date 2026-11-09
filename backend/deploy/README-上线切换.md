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

## 第四步：切换前端（1 行改动）

`miniprogram/utils/api.js`：

```js
const SERVER = 'https://zaizaidaka.site';   // 原 http://152.136.58.30:8001
```

mp 后台 → 开发与服务 → 开发设置 → **服务器域名** → request 合法域名添加：

```
https://zaizaidaka.site
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
