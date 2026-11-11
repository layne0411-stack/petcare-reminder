# -*- coding: utf-8 -*-
"""
宠物护理提醒 · 后端服务（FastAPI）
- 数据库：MySQL（云服务器）——通过 .env 配置连接；也支持 DB_DRIVER=sqlite 本地零依赖
- 静默登录：wx.login code 换 openid，签发自定义 token
- 任务 CRUD / 完成打卡 / 历史记录 / 订阅配额
- 定时任务：每天北京时间 9:00 给当天到期且有配额的用户发订阅消息

启动：
  uvicorn app:app --host 0.0.0.0 --port 8000

安全说明：
  AppSecret / 数据库密码等敏感信息一律走 .env / 环境变量，禁止写入代码和前端。
"""
import os
import time
import hmac
import hashlib
import base64
import json
import secrets
from datetime import datetime, timedelta, date
from contextlib import asynccontextmanager
from typing import Optional

import requests
from apscheduler.schedulers.background import BackgroundScheduler
from fastapi import FastAPI, HTTPException, Header, Depends
from fastapi.responses import FileResponse
from pydantic import BaseModel

# 读取 backend/.env 配置文件（python-dotenv；已有同名环境变量时以系统环境变量优先）
try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))
except ImportError:
    pass

from database import query, execute, as_date, init as db_init

# ---------- 配置 ----------
WX_APPID = os.environ.get("WX_APPID", "")
WX_SECRET = os.environ.get("WX_SECRET", "")
TEMPLATE_ID = os.environ.get("TEMPLATE_ID", "")
TOKEN_SECRET = os.environ.get("TOKEN_SECRET", secrets.token_hex(32))  # 不设则每次重启旧登录态失效
TOKEN_TTL_DAYS = 30

# 本地开发模式：没配 AppSecret 时，任何 code 都登录为 dev 用户（方便本地跑通，服务器上必须配置真实 Secret）
DEV_LOGIN = not WX_SECRET

# 订阅消息字段名（已按用户申领的「待办事项提醒」模板核对，2026-11-03）
# 模板字段：事项主题=thing1，记录名称=thing5，剩余时间=short_thing20
# 注意：short_thing 对长度有限制（5 个以内汉字，需以官方文档核实），剩余时间文案控制在 5 字内
TEMPLATE_FIELDS = ("thing1", "thing5", "short_thing20")

# 头像上传目录（用户头像仅本人可见，不作公开展示）
UPLOAD_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)
AVATAR_MAX_BYTES = 2 * 1024 * 1024  # 2MB 上限

# 图片真实格式识别表（按文件头判断，不信任 data URL 里声明的类型）
_IMG_MAGIC = (
    (b"\xff\xd8\xff", "jpg", "image/jpeg"),
    (b"\x89PNG\r\n\x1a\n", "png", "image/png"),
    (b"GIF8", "gif", "image/gif"),
)


def sniff_image(raw: bytes):
    """返回 (扩展名, MIME)；无法识别返回 (None, None)

    ⚠️ 关键：微信 chooseAvatar 拿到的临时文件路径可能没有扩展名（如 http://tmp/xxxx），
    前端据此声明的 MIME 可能与真实内容不符，导致 <image> 解析失败显示空白。
    这里一律以文件头为准。
    """
    for magic, ext, mime in _IMG_MAGIC:
        if raw.startswith(magic):
            return ext, mime
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "webp", "image/webp"
    return None, None


def avatar_data_url(path: str) -> str:
    """把 /uploads/xxx 的头像转成 data URL

    前端用内联 base64 渲染头像，彻底绕开「<image> 加载远程图需要 downloadFile 合法域名」
    的限制（未配置域名时远程图会静默失败 → 空白）。
    """
    if not path or not path.startswith("/uploads/"):
        return ""
    full = os.path.join(UPLOAD_DIR, os.path.basename(path))
    if not os.path.isfile(full):
        return ""
    try:
        with open(full, "rb") as f:
            raw = f.read(AVATAR_MAX_BYTES + 1)
    except OSError:
        return ""
    ext, mime = sniff_image(raw[:16])
    if not mime:
        return ""
    return f"data:{mime};base64,{base64.b64encode(raw).decode()}"


# ---------- 登录态（HMAC 签名 token，无额外依赖） ----------
def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _b64url_decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def make_token(user_id: int) -> str:
    payload = {"uid": user_id, "exp": int(time.time()) + TOKEN_TTL_DAYS * 86400}
    body = _b64url(json.dumps(payload).encode())
    sig = _b64url(hmac.new(TOKEN_SECRET.encode(), body.encode(), hashlib.sha256).digest())
    return f"{body}.{sig}"


def parse_token(token: str) -> Optional[int]:
    try:
        body, sig = token.split(".")
        expect = _b64url(hmac.new(TOKEN_SECRET.encode(), body.encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(sig, expect):
            return None
        payload = json.loads(_b64url_decode(body))
        if payload["exp"] < time.time():
            return None
        return int(payload["uid"])
    except Exception:
        return None


def current_user(authorization: str = Header(default="")) -> int:
    if not authorization.startswith("Bearer "):
        raise HTTPException(401, "未登录")
    uid = parse_token(authorization[7:])
    if uid is None:
        raise HTTPException(401, "登录态已过期")
    return uid


# ---------- 微信开放接口（仅服务端调用） ----------
_access_token_cache = {"token": "", "expire": 0.0}


def get_access_token() -> str:
    """获取全局 access_token，带内存缓存（有效期 7200 秒，提前 5 分钟刷新）"""
    if _access_token_cache["token"] and time.time() < _access_token_cache["expire"] - 300:
        return _access_token_cache["token"]
    r = requests.get(
        "https://api.weixin.qq.com/cgi-bin/token",
        params={"grant_type": "client_credential", "appid": WX_APPID, "secret": WX_SECRET},
        timeout=10,
    ).json()
    if "access_token" not in r:
        raise RuntimeError(f"获取 access_token 失败: {r}")
    _access_token_cache["token"] = r["access_token"]
    _access_token_cache["expire"] = time.time() + r.get("expires_in", 7200)
    return r["access_token"]


def send_subscribe(openid: str, title: str, record_name: str, remain_text: str) -> dict:
    """发送一次性订阅消息。字段映射：
    thing1=事项主题(任务名) / thing5=记录名称(宠物或设备名) / short_thing20=剩余时间(≤5字)"""
    data = {
        TEMPLATE_FIELDS[0]: {"value": title[:20]},
        TEMPLATE_FIELDS[1]: {"value": (record_name or "护理任务")[:20]},
        TEMPLATE_FIELDS[2]: {"value": remain_text[:5]},
    }
    r = requests.post(
        "https://api.weixin.qq.com/cgi-bin/message/subscribe/send",
        params={"access_token": get_access_token()},
        json={
            "touser": openid,
            "template_id": TEMPLATE_ID,
            "page": "pages/index/index",
            "data": data,
        },
        timeout=10,
    ).json()
    return r  # {"errcode":0} 成功；43101=用户未订阅/配额用完；47003=模板字段不匹配


# ---------- 定时提醒（每天北京时间 9:00） ----------
def beijing_today() -> date:
    return (datetime.utcnow() + timedelta(hours=8)).date()


def remain_text_for(next_due: date, today: date) -> str:
    """剩余时间文案（short_thing 字段，5 字以内）"""
    days = (next_due - today).days
    if days == 0:
        return "今天到期"
    if days > 0:
        return f"剩{days}天" if days < 100 else "已可执行"
    return f"逾期{-days}天" if -days < 100 else "已逾期"


def _now_beijing() -> datetime:
    return datetime.utcnow() + timedelta(hours=8)


def _log_notify(uid: int, task_id: int, title: str, ok: bool, errcode: int, errmsg: str = ""):
    """把每次发送结果落库，用于「为什么没收到提醒」的排查与防重复发送"""
    execute(
        """INSERT INTO notify_logs (user_id, task_id, task_title, sent_at, ok, errcode, errmsg)
           VALUES (%s,%s,%s,%s,%s,%s,%s)""",
        (uid, task_id, title[:60], _now_beijing().strftime("%Y-%m-%d %H:%M:%S"),
         1 if ok else 0, int(errcode or 0), (errmsg or "")[:120]),
    )


def notify_due_tasks(force: bool = False):
    """按任务设置的提醒时间扫描并发送

    - 触发日 = next_due - advance_days（提前提醒）；等于今天才发
    - remind_hour 已过且今天还没成功发过 → 发送（失败会在当天后续整点重试）
    - 每条任务只有一次性订阅的配额，发一条即扣 1
    - force=True：忽略提醒时间限制，用于手动联调
    """
    now = _now_beijing()
    today = now.date()
    hour = now.hour
    rows = query(
        """SELECT t.id, t.user_id, t.pet_name, t.type_name, t.quota, t.next_due,
                  t.remind_hour, t.advance_days, u.openid
           FROM tasks t JOIN users u ON t.user_id = u.id
           WHERE t.remind_enabled = 1 AND t.quota > 0
           ORDER BY t.next_due ASC LIMIT 500"""
    )
    sent, skipped, errors = 0, 0, []
    for row in rows:
        remind_hour = int(row.get("remind_hour") if row.get("remind_hour") is not None else 9)
        advance = int(row.get("advance_days") or 0)
        if not force and remind_hour > hour:
            skipped += 1
            continue
        due = as_date(row["next_due"])
        if due - timedelta(days=advance) != today:
            skipped += 1
            continue
        # 今天已经成功发过 → 不重复发（每小时扫描的幂等保护）
        already = query(
            "SELECT id FROM notify_logs WHERE task_id = %s AND ok = 1 AND DATE(sent_at) = %s LIMIT 1",
            (row["id"], today.isoformat()),
            one=True,
        )
        if already:
            skipped += 1
            continue

        title = f"{row['pet_name']}的{row['type_name']}" if row["pet_name"] else row["type_name"]
        days = (due - today).days
        remain = remain_text_for(due, today) if days <= 0 else f"还有{days}天"
        r = send_subscribe(row["openid"], title, row["pet_name"] or "护理任务", remain)
        code = int(r.get("errcode") or 0)
        if code == 0:
            execute("UPDATE tasks SET quota = quota - 1 WHERE id = %s", (row["id"],))
            _log_notify(row["user_id"], row["id"], title, True, 0)
            sent += 1
        else:
            # 永久性失败：清了配额，避免每小时重复失败
            # 43101=用户未订阅/配额用尽；40003=openid 无效；47003=模板字段不匹配；41030=模板被删
            if code in (43101, 40003, 47003, 41030):
                execute("UPDATE tasks SET quota = 0 WHERE id = %s", (row["id"],))
            _log_notify(row["user_id"], row["id"], title, False, code, r.get("errmsg", ""))
            errors.append({"taskId": row["id"], "errcode": code, "errmsg": r.get("errmsg", "")})
    print(f"[notify] {now:%Y-%m-%d %H:%M} 检查 {len(rows)} 条，发送 {sent} 条，跳过 {skipped}，异常 {errors}")
    return {"checked": len(rows), "sent": sent, "skipped": skipped, "errors": errors}


@asynccontextmanager
async def lifespan(app: FastAPI):
    db_init()
    sched = BackgroundScheduler(timezone="Asia/Shanghai")
    # 每小时第 5 分钟扫描一次：任务可各自设置提醒整点，失败可在当天后续整点重试
    sched.add_job(notify_due_tasks, "cron", minute=5, id="hourlyNotify", replace_existing=True)
    sched.start()
    yield
    sched.shutdown()


app = FastAPI(lifespan=lifespan)


@app.get("/api/ping")
def ping():
    """连通性探测：小程序启动时用它自动选出手机可达的后端地址"""
    return {"ok": True, "server": "petcare", "time": datetime.now().isoformat(timespec="seconds")}


# ---------- 请求模型 ----------
class LoginIn(BaseModel):
    code: str


class TaskIn(BaseModel):
    typeName: str
    petId: Optional[int] = None  # 关联宠物；为空表示家居/设备类任务
    petName: str = ""            # 无关联宠物时的设备名快照（如「净水器」）
    intervalDays: int
    lastDone: Optional[str] = None  # 'YYYY-MM-DD'，空则视为今天
    remindEnabled: bool = True
    remindHour: int = 9              # 提醒整点（0-23），默认早 9 点
    advanceDays: int = 0             # 提前提醒天数，0 = 到期当天
    note: str = ""
    # 前端在保存点击的同一上下文里弹出订阅授权，把用户是否同意一并带上来，
    # 避免"先加配额后建任务"导致 UPDATE 命中 0 行而丢配额
    subscribeAccepted: bool = False


class PetIn(BaseModel):
    name: str
    species: str = "other"   # dog / cat / rabbit / hamster / bird / fish / reptile / other
    avatar: str = ""         # emoji，如 🐶
    breed: str = ""
    birthday: Optional[str] = None  # 'YYYY-MM-DD'
    gender: int = 0          # 0 未知 / 1 公 / 2 母
    note: str = ""


class QuotaIn(BaseModel):
    taskId: Optional[int] = None


class CompleteIn(BaseModel):
    # 允许补记：不传则记为今天；只接受今天及以前的日期
    doneDate: Optional[str] = None


class RecordIn(BaseModel):
    doneDate: str


class WeightIn(BaseModel):
    weight: float
    date: Optional[str] = None
    note: str = ""


class TemplateIn(BaseModel):
    # 用户为这批任务授权了订阅 → 生成的任务直接给 1 条配额
    subscribeAccepted: bool = False


class UserProfileIn(BaseModel):
    nickname: Optional[str] = None
    avatar: Optional[str] = None  # 支持 emoji 预设，或 /uploads/xxx.png 路径


class AvatarIn(BaseModel):
    # 前端 wx.chooseAvatar 拿到图片后转 base64 data URL 上传，避免 multipart 依赖
    dataUrl: str


SPECIES_META = {
    "dog":     {"label": "狗狗", "emoji": "🐶"},
    "cat":     {"label": "猫猫", "emoji": "🐱"},
    "rabbit":  {"label": "兔兔", "emoji": "🐰"},
    "hamster": {"label": "仓鼠", "emoji": "🐹"},
    "bird":    {"label": "鸟鸟", "emoji": "🦜"},
    "fish":    {"label": "鱼鱼", "emoji": "🐠"},
    "reptile": {"label": "爬宠", "emoji": "🦎"},
    "other":   {"label": "其他", "emoji": "🐾"},
    # 兼容历史数据：早期版本只有 dog/cat/small/other，small 统一按兔兔展示
    "small":   {"label": "小宠", "emoji": "🐰"},
}


def _pet_out(row: dict) -> dict:
    species = (row.get("species") or "other").strip()
    meta = SPECIES_META.get(species, SPECIES_META["other"])
    nd = row.get("next_due")
    # 头像可能是 emoji，也可能是上传后的 /uploads/xxx.jpg 路径
    raw_avatar = (row.get("avatar") or "").strip()
    is_photo = raw_avatar.startswith("/uploads/")
    next_due = as_date(nd) if nd else None
    gender = int(row.get("gender") or 0)
    return {
        "id": row["id"],
        "name": row["name"],
        "species": species if species in SPECIES_META else "other",
        "speciesLabel": meta["label"],
        "avatar": raw_avatar or meta["emoji"],
        "avatarImg": raw_avatar if is_photo else "",
        "avatarEmoji": meta["emoji"] if is_photo else (raw_avatar or meta["emoji"]),
        "breed": row.get("breed") or "",
        "birthday": str(row["birthday"])[:10] if row.get("birthday") else "",
        "gender": gender,
        "genderLabel": {1: "弟弟", 2: "妹妹"}.get(gender, ""),
        "note": row.get("note") or "",
        "taskCount": int(row.get("task_count") or 0),
        "nextDue": next_due.isoformat() if next_due else "",
        "daysLeft": (next_due - beijing_today()).days if next_due else None,
        "latestWeight": float(row["latest_weight"]) if row.get("latest_weight") is not None else None,
    }


def _task_out(row: dict) -> dict:
    next_due = as_date(row["next_due"])
    last_done = as_date(row["last_done"]) if row["last_done"] else None
    # 宠物头像/种类来自 LEFT JOIN；宠物改名后以 pets.name 为准，删除后回落到快照
    live_name = row.get("pet_live_name")
    raw_avatar = (row.get("pet_avatar") or "").strip()
    species = row.get("pet_species") or ""
    fallback_emoji = SPECIES_META.get(species, SPECIES_META["other"])["emoji"]
    is_photo = raw_avatar.startswith("/uploads/")
    return {
        "id": row["id"],
        "typeName": row["type_name"],
        "petId": row.get("pet_id"),
        "petName": live_name or row["pet_name"],
        "petAvatar": raw_avatar,
        "petAvatarImg": raw_avatar if is_photo else "",
        "petAvatarEmoji": fallback_emoji if is_photo else (raw_avatar or fallback_emoji),
        "petSpecies": species,
        "intervalDays": row["interval_days"],
        "lastDone": last_done.isoformat() if last_done else "",
        "nextDue": next_due.isoformat(),
        "remindEnabled": bool(row["remind_enabled"]),
        "remindHour": int(row.get("remind_hour") if row.get("remind_hour") is not None else 9),
        "advanceDays": int(row.get("advance_days") or 0),
        "note": row["note"],
        "daysLeft": (next_due - beijing_today()).days,
    }


def _validate_task(body: TaskIn):
    if not body.typeName.strip():
        raise HTTPException(400, "任务名称不能为空")
    if not (1 <= body.intervalDays <= 3650):
        raise HTTPException(400, "间隔天数需在 1-3650 之间")
    if not (0 <= body.remindHour <= 23):
        raise HTTPException(400, "提醒时间需在 0-23 点之间")
    if not (0 <= body.advanceDays <= 30):
        raise HTTPException(400, "提前提醒天数需在 0-30 之间")


def _resolve_pet(uid: int, pet_id: Optional[int]):
    """校验宠物归属，返回 (pet_id, 宠物名)；未选择宠物返回 (None, '')"""
    if not pet_id:
        return None, ""
    row = query(
        "SELECT id, name FROM pets WHERE id = %s AND user_id = %s", (pet_id, uid), one=True
    )
    if not row:
        raise HTTPException(404, "宠物不存在")
    return row["id"], row["name"]


# ---------- 接口 ----------
@app.post("/api/login")
def login(body: LoginIn):
    """wx.login 的 code 换 openid（code2Session），upsert 用户并签发 token"""
    if DEV_LOGIN:
        # 本地开发模式：没有 AppSecret，用固定 dev 用户跑通流程
        openid = "dev_user"
    else:
        r = requests.get(
            "https://api.weixin.qq.com/sns/jscode2session",
            params={
                "appid": WX_APPID,
                "secret": WX_SECRET,
                "js_code": body.code,
                "grant_type": "authorization_code",
            },
            timeout=10,
        ).json()
        if "openid" not in r:
            raise HTTPException(400, f"code2Session 失败: {r}")
        openid = r["openid"]

    row = query("SELECT id, nickname, avatar FROM users WHERE openid = %s", (openid,), one=True)
    if row:
        uid = row["id"]
        execute("UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = %s", (uid,))
        nickname, avatar = row["nickname"], row["avatar"]
    else:
        uid = execute("INSERT INTO users (openid) VALUES (%s)", (openid,))
        nickname, avatar = "", ""
    return {
        "token": make_token(uid),
        "userId": uid,
        "nickname": nickname,
        "avatar": avatar,
        "avatarDataUrl": avatar_data_url(avatar),
    }


# ---------- 用户资料 ----------
def _profile_payload(uid: int) -> dict:
    u = query(
        "SELECT id, nickname, avatar, created_at FROM users WHERE id = %s", (uid,), one=True
    )
    if not u:
        raise HTTPException(404, "用户不存在")
    t = query("SELECT COUNT(*) AS c FROM tasks WHERE user_id = %s", (uid,), one=True)
    r = query("SELECT COUNT(*) AS c FROM records WHERE user_id = %s", (uid,), one=True)
    p = query("SELECT COUNT(*) AS c FROM pets WHERE user_id = %s", (uid,), one=True)
    # 可发送提醒条数：一次性订阅的剩余配额总和，给用户一个「还能收到几条」的判断依据
    q = query(
        "SELECT COALESCE(SUM(quota), 0) AS q FROM tasks WHERE user_id = %s AND remind_enabled = 1",
        (uid,),
        one=True,
    )
    return {
        "userId": u["id"],
        "nickname": u["nickname"],
        "avatar": u["avatar"],
        "avatarDataUrl": avatar_data_url(u["avatar"]),
        "joinedAt": str(u["created_at"])[:10],
        "taskCount": int(t["c"]),
        "recordCount": int(r["c"]),
        "petCount": int(p["c"]),
        "quotaLeft": int(q["q"] or 0),
    }


@app.get("/api/user/profile")
def get_profile(uid: int = Depends(current_user)):
    """当前登录用户资料 + 使用统计（调用即视为登录态校验）"""
    return _profile_payload(uid)


@app.put("/api/user/profile")
def update_profile(body: UserProfileIn, uid: int = Depends(current_user)):
    """更新昵称 / 头像（头像可为 emoji 预设或上传后的路径）"""
    sets, params = [], []
    if body.nickname is not None:
        nick = body.nickname.strip()[:30]
        if not nick:
            raise HTTPException(400, "昵称不能为空")
        sets.append("nickname = %s")
        params.append(nick)
    if body.avatar is not None:
        sets.append("avatar = %s")
        params.append(body.avatar.strip()[:255])
    if not sets:
        raise HTTPException(400, "没有需要更新的字段")
    params.append(uid)
    execute(f"UPDATE users SET {', '.join(sets)} WHERE id = %s", tuple(params))
    return _profile_payload(uid)


@app.post("/api/user/avatar")
def upload_avatar(body: AvatarIn, uid: int = Depends(current_user)):
    """上传头像：base64 data URL → 落盘 uploads/ → 返回可访问路径"""
    data = body.dataUrl or ""
    if "," not in data:
        raise HTTPException(400, "图片格式不正确")
    head, b64 = data.split(",", 1)
    try:
        raw = base64.b64decode(b64)
    except Exception:
        raise HTTPException(400, "图片数据无法解析")
    if len(raw) > AVATAR_MAX_BYTES:
        raise HTTPException(400, "图片过大，请控制在 2MB 以内")
    if not raw:
        raise HTTPException(400, "图片为空")

    # 以文件头判断真实格式（前端传的 MIME 可能是错的，见 sniff_image 注释）
    ext, mime = sniff_image(raw[:16])
    if not mime:
        raise HTTPException(400, "图片格式不支持，请重新选择")

    filename = f"u{uid}_{int(time.time())}.{ext}"
    with open(os.path.join(UPLOAD_DIR, filename), "wb") as f:
        f.write(raw)

    # 清理该用户的旧头像文件，避免无限堆积（宠物照片前缀 u{uid}_pet_ ，不能一起删）
    for old in os.listdir(UPLOAD_DIR):
        if old.startswith(f"u{uid}_") and "_pet_" not in old and old != filename:
            try:
                os.remove(os.path.join(UPLOAD_DIR, old))
            except OSError:
                pass

    path = f"/uploads/{filename}"
    execute("UPDATE users SET avatar = %s WHERE id = %s", (path, uid))
    return {
        "avatar": path,
        "avatarDataUrl": f"data:{mime};base64,{base64.b64encode(raw).decode()}",
    }


@app.post("/api/pet-avatar")
def upload_pet_avatar(body: AvatarIn, uid: int = Depends(current_user)):
    """上传宠物照片作为头像：base64 data URL → 落盘 uploads/ → 返回可访问路径

    新建宠物时还没有 pet_id，所以这里只负责存文件，路径随 /api/pets 的 avatar 字段提交。
    """
    data = body.dataUrl or ""
    if "," not in data:
        raise HTTPException(400, "图片格式不正确")
    head, b64 = data.split(",", 1)
    try:
        raw = base64.b64decode(b64)
    except Exception:
        raise HTTPException(400, "图片数据无法解析")
    if len(raw) > AVATAR_MAX_BYTES:
        raise HTTPException(400, "图片过大，请控制在 2MB 以内")
    if not raw:
        raise HTTPException(400, "图片为空")

    ext, mime = sniff_image(raw[:16])
    if not mime:
        raise HTTPException(400, "图片格式不支持，请重新选择")

    filename = f"u{uid}_pet_{int(time.time() * 1000)}.{ext}"
    with open(os.path.join(UPLOAD_DIR, filename), "wb") as f:
        f.write(raw)

    # 只清理该用户更早的宠物照片，用户自己的头像不动
    for old in os.listdir(UPLOAD_DIR):
        if old.startswith(f"u{uid}_pet_") and old != filename:
            try:
                os.remove(os.path.join(UPLOAD_DIR, old))
            except OSError:
                pass

    return {
        "avatar": f"/uploads/{filename}",
        "avatarDataUrl": f"data:{mime};base64,{base64.b64encode(raw).decode()}",
    }


@app.get("/uploads/{filename}")
def serve_upload(filename: str):
    """提供头像文件访问（文件名带用户 ID 与时间戳，不可枚举）"""
    safe = os.path.basename(filename)
    full = os.path.join(UPLOAD_DIR, safe)
    if not os.path.isfile(full):
        raise HTTPException(404, "文件不存在")
    try:
        with open(full, "rb") as f:
            _, mime = sniff_image(f.read(16))
    except OSError:
        raise HTTPException(404, "文件不存在")
    return FileResponse(
        full,
        media_type=mime or "application/octet-stream",
        headers={"Cache-Control": "public, max-age=86400"},
    )


@app.get("/api/tasks")
def list_tasks(uid: int = Depends(current_user)):
    rows = query(
        """SELECT t.*, p.avatar AS pet_avatar, p.species AS pet_species, p.name AS pet_live_name
           FROM tasks t LEFT JOIN pets p ON t.pet_id = p.id
           WHERE t.user_id = %s ORDER BY t.next_due ASC LIMIT 200""",
        (uid,),
    )
    return {"list": [_task_out(r) for r in rows]}


@app.get("/api/tasks/{task_id}")
def get_task(task_id: int, uid: int = Depends(current_user)):
    row = query(
        """SELECT t.*, p.avatar AS pet_avatar, p.species AS pet_species, p.name AS pet_live_name
           FROM tasks t LEFT JOIN pets p ON t.pet_id = p.id
           WHERE t.id = %s AND t.user_id = %s""",
        (task_id, uid),
        one=True,
    )
    if not row:
        raise HTTPException(404, "任务不存在")
    return _task_out(row)


@app.post("/api/tasks")
def create_task(body: TaskIn, uid: int = Depends(current_user)):
    _validate_task(body)
    pet_id, pet_name = _resolve_pet(uid, body.petId)
    if not pet_id:
        pet_name = body.petName.strip()
    last = body.lastDone or beijing_today().isoformat()
    next_due = (datetime.strptime(last, "%Y-%m-%d") + timedelta(days=body.intervalDays)).date()
    # 用户在这次保存时同意了订阅 → 新任务直接获得 1 次发送配额
    quota = 1 if body.subscribeAccepted else 0
    new_id = execute(
        """INSERT INTO tasks
           (user_id, pet_id, type_name, pet_name, interval_days, last_done, next_due,
            remind_enabled, remind_hour, advance_days, note, quota)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
        (uid, pet_id, body.typeName.strip(), pet_name, body.intervalDays,
         last, next_due.isoformat(), int(body.remindEnabled), body.remindHour,
         body.advanceDays, body.note.strip(), quota),
    )
    return {"id": new_id, "quota": quota}


@app.put("/api/tasks/{task_id}")
def update_task(task_id: int, body: TaskIn, uid: int = Depends(current_user)):
    _validate_task(body)
    owned = query("SELECT id FROM tasks WHERE id = %s AND user_id = %s", (task_id, uid), one=True)
    if not owned:
        raise HTTPException(404, "任务不存在")
    pet_id, pet_name = _resolve_pet(uid, body.petId)
    if not pet_id:
        pet_name = body.petName.strip()
    last = body.lastDone or beijing_today().isoformat()
    next_due = (datetime.strptime(last, "%Y-%m-%d") + timedelta(days=body.intervalDays)).date()
    quota_inc = 1 if body.subscribeAccepted else 0
    execute(
        """UPDATE tasks SET pet_id=%s, type_name=%s, pet_name=%s, interval_days=%s,
           last_done=%s, next_due=%s, remind_enabled=%s, remind_hour=%s, advance_days=%s,
           note=%s, quota = quota + %s
           WHERE id=%s AND user_id=%s""",
        (pet_id, body.typeName.strip(), pet_name, body.intervalDays,
         last, next_due.isoformat(), int(body.remindEnabled), body.remindHour,
         body.advanceDays, body.note.strip(), quota_inc, task_id, uid),
    )
    return {"ok": True, "quotaAdded": quota_inc}


@app.delete("/api/tasks/{task_id}")
def delete_task(task_id: int, uid: int = Depends(current_user)):
    execute("DELETE FROM tasks WHERE id = %s AND user_id = %s", (task_id, uid))
    return {"ok": True}


def _parse_done_date(raw: Optional[str], today: date) -> date:
    """打卡日期：默认今天，只接受今天及以前（补记），太早（>3 年）视为无效"""
    if not raw:
        return today
    try:
        d = datetime.strptime(raw.strip()[:10], "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(400, "日期格式应为 YYYY-MM-DD")
    if d > today:
        raise HTTPException(400, "还不能给未来的日子打卡哦")
    if (today - d).days > 1095:
        raise HTTPException(400, "日期太早了，请检查一下")
    return d


def _recalc_task(task_id: int, uid: int, fallback_interval: int):
    """按剩余记录重算任务的 last_done / next_due（删除或改日期记录后调用）

    没有记录时：last_done 置空，next_due = 今天 + 间隔，避免立刻变成逾期。
    """
    last = query(
        """SELECT done_date FROM records WHERE task_id = %s AND user_id = %s
           ORDER BY done_date DESC, id DESC LIMIT 1""",
        (task_id, uid),
        one=True,
    )
    if last:
        d = as_date(last["done_date"])
        execute(
            "UPDATE tasks SET last_done = %s, next_due = %s WHERE id = %s AND user_id = %s",
            (d.isoformat(), (d + timedelta(days=fallback_interval)).isoformat(), task_id, uid),
        )
        return (d + timedelta(days=fallback_interval)).isoformat()
    nd = beijing_today() + timedelta(days=fallback_interval)
    execute(
        "UPDATE tasks SET last_done = NULL, next_due = %s WHERE id = %s AND user_id = %s",
        (nd.isoformat(), task_id, uid),
    )
    return nd.isoformat()


@app.post("/api/tasks/{task_id}/complete")
def complete_task(task_id: int, body: Optional[CompleteIn] = None, uid: int = Depends(current_user)):
    """完成打卡：写记录 + 顺延下次到期日

    - 支持补记：body.doneDate 指定完成日期（不传=今天）
    - 幂等：同一任务同一天重复提交不会重复写记录、不会重复顺延
    """
    today = beijing_today()
    task = query("SELECT * FROM tasks WHERE id = %s AND user_id = %s", (task_id, uid), one=True)
    if not task:
        raise HTTPException(404, "任务不存在")

    done = _parse_done_date(body.doneDate if body else None, today)

    dup = query(
        "SELECT id FROM records WHERE task_id = %s AND user_id = %s AND done_date = %s",
        (task_id, uid, done.isoformat()),
        one=True,
    )
    if dup:
        return {
            "alreadyDone": True,
            "nextDue": as_date(task["next_due"]).isoformat(),
            "doneDate": done.isoformat(),
        }

    execute(
        """INSERT INTO records (user_id, task_id, pet_id, pet_name, type_name, note, done_date)
           VALUES (%s,%s,%s,%s,%s,%s,%s)""",
        (uid, task_id, task.get("pet_id"), task["pet_name"], task["type_name"], task["note"], done.isoformat()),
    )
    # 补记旧日期时不能让到期日往回退：统一按「最新一条记录」重算
    next_due_str = _recalc_task(task_id, uid, task["interval_days"])
    return {"nextDue": next_due_str, "doneDate": done.isoformat(), "alreadyDone": False}


@app.post("/api/quota")
def add_quota(body: QuotaIn, uid: int = Depends(current_user)):
    """前端 wx.requestSubscribeMessage 用户同意后调用，+1 条发送配额"""
    if body.taskId:
        execute(
            "UPDATE tasks SET quota = quota + 1 WHERE id = %s AND user_id = %s AND remind_enabled = 1",
            (body.taskId, uid),
        )
    else:
        # 没有指定任务时（如「我的」页续订）：给最近要到期的那个任务 +1，
        # 一次性订阅只能发一条，不要给所有任务都记一次（会造成虚假配额）
        row = query(
            """SELECT id FROM tasks WHERE user_id = %s AND remind_enabled = 1
               ORDER BY next_due ASC LIMIT 1""",
            (uid,),
            one=True,
        )
        if row:
            execute("UPDATE tasks SET quota = quota + 1 WHERE id = %s", (row["id"],))
    return {"ok": True}


@app.get("/api/notify/logs")
def list_notify_logs(uid: int = Depends(current_user)):
    """最近的提醒发送记录：让用户/自己能看出「为什么没收到提醒」"""
    rows = query(
        """SELECT id, task_id, task_title, sent_at, ok, errcode, errmsg
           FROM notify_logs WHERE user_id = %s ORDER BY id DESC LIMIT 20""",
        (uid,),
    )
    return {
        "list": [
            {
                "id": r["id"],
                "taskId": r["task_id"],
                "title": r["task_title"],
                "sentAt": str(r["sent_at"])[:16],
                "ok": bool(r["ok"]),
                "errcode": int(r["errcode"] or 0),
                "errmsg": r["errmsg"],
            }
            for r in rows
        ]
    }


@app.get("/api/records")
def list_records(uid: int = Depends(current_user)):
    rows = query(
        """SELECT r.id, r.task_id, r.pet_id, r.pet_name, r.type_name, r.note, r.done_date,
                  p.avatar AS pet_avatar, p.name AS pet_live_name
           FROM records r LEFT JOIN pets p ON r.pet_id = p.id
           WHERE r.user_id = %s ORDER BY r.done_date DESC, r.id DESC LIMIT 200""",
        (uid,),
    )
    return {
        "list": [
            {
                "id": r["id"],
                "taskId": r.get("task_id"),
                "petId": r.get("pet_id"),
                "petName": r.get("pet_live_name") or r["pet_name"],
                "petAvatar": r.get("pet_avatar") or "",
                "typeName": r["type_name"],
                "note": r["note"],
                "doneDate": as_date(r["done_date"]).isoformat(),
            }
            for r in rows
        ]
    }


@app.delete("/api/records/{record_id}")
def delete_record(record_id: int, uid: int = Depends(current_user)):
    """删除一条打卡记录（相当于撤销），并把所属任务的到期日回滚到上一条记录"""
    row = query(
        "SELECT id, task_id FROM records WHERE id = %s AND user_id = %s", (record_id, uid), one=True
    )
    if not row:
        raise HTTPException(404, "记录不存在")
    task = query(
        "SELECT id, interval_days FROM tasks WHERE id = %s AND user_id = %s",
        (row["task_id"], uid),
        one=True,
    )
    execute("DELETE FROM records WHERE id = %s AND user_id = %s", (record_id, uid))
    next_due = None
    if task:
        next_due = _recalc_task(task["id"], uid, task["interval_days"])
    return {"ok": True, "nextDue": next_due}


@app.put("/api/records/{record_id}")
def update_record(record_id: int, body: RecordIn, uid: int = Depends(current_user)):
    """修改打卡日期（补记/纠正），并重算任务到期日"""
    row = query(
        "SELECT id, task_id, done_date FROM records WHERE id = %s AND user_id = %s",
        (record_id, uid),
        one=True,
    )
    if not row:
        raise HTTPException(404, "记录不存在")
    today = beijing_today()
    done = _parse_done_date(body.doneDate, today)
    dup = query(
        """SELECT id FROM records WHERE task_id = %s AND user_id = %s AND done_date = %s
           AND id <> %s""",
        (row["task_id"], uid, done.isoformat(), record_id),
        one=True,
    )
    if dup:
        raise HTTPException(409, "这一天已经有一条打卡记录了")
    execute(
        "UPDATE records SET done_date = %s WHERE id = %s AND user_id = %s",
        (done.isoformat(), record_id, uid),
    )
    task = query(
        "SELECT id, interval_days FROM tasks WHERE id = %s AND user_id = %s",
        (row["task_id"], uid),
        one=True,
    )
    next_due = _recalc_task(task["id"], uid, task["interval_days"]) if task else None
    return {"ok": True, "doneDate": done.isoformat(), "nextDue": next_due}


# ---------- 宠物档案 ----------
@app.get("/api/pets")
def list_pets(uid: int = Depends(current_user)):
    rows = query(
        """SELECT p.*,
                  (SELECT COUNT(*) FROM tasks t WHERE t.pet_id = p.id) AS task_count,
                  (SELECT MIN(t.next_due) FROM tasks t WHERE t.pet_id = p.id) AS next_due,
                  (SELECT w.weight FROM pet_weights w WHERE w.pet_id = p.id
                   ORDER BY w.record_date DESC, w.id DESC LIMIT 1) AS latest_weight
           FROM pets p WHERE p.user_id = %s ORDER BY p.id ASC""",
        (uid,),
    )
    return {"list": [_pet_out(r) for r in rows]}


@app.get("/api/pets/{pet_id}")
def get_pet(pet_id: int, uid: int = Depends(current_user)):
    row = query("SELECT * FROM pets WHERE id = %s AND user_id = %s", (pet_id, uid), one=True)
    if not row:
        raise HTTPException(404, "宠物不存在")
    row["task_count"] = query(
        "SELECT COUNT(*) AS c FROM tasks WHERE pet_id = %s", (pet_id,), one=True
    )["c"]
    row["next_due"] = query(
        "SELECT MIN(next_due) AS d FROM tasks WHERE pet_id = %s", (pet_id,), one=True
    )["d"]
    lw = query(
        """SELECT weight FROM pet_weights WHERE pet_id = %s
           ORDER BY record_date DESC, id DESC LIMIT 1""",
        (pet_id,),
        one=True,
    )
    row["latest_weight"] = lw["weight"] if lw else None
    return _pet_out(row)


def _pet_values(body: PetIn):
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(400, "宠物名字不能为空")
    species = (body.species or "other").strip()
    if species not in SPECIES_META:
        species = "other"
    avatar_raw = (body.avatar or "").strip()
    if avatar_raw.startswith("/uploads/"):
        # 上传的宠物照片（由 /api/pet-avatar 返回），只接受本站 uploads 路径
        avatar = avatar_raw[:255]
    else:
        avatar = avatar_raw[:8] or SPECIES_META[species]["emoji"]
    birthday = (body.birthday or "").strip() or None
    if birthday:
        try:
            datetime.strptime(birthday, "%Y-%m-%d")
        except ValueError:
            raise HTTPException(400, "生日格式应为 YYYY-MM-DD")
    gender = body.gender if body.gender in (0, 1, 2) else 0
    return name[:30], species, avatar, (body.breed or "").strip()[:30], birthday, gender, (body.note or "").strip()[:100]


@app.post("/api/pets")
def create_pet(body: PetIn, uid: int = Depends(current_user)):
    name, species, avatar, breed, birthday, gender, note = _pet_values(body)
    new_id = execute(
        """INSERT INTO pets (user_id, name, species, avatar, breed, birthday, gender, note)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s)""",
        (uid, name, species, avatar, breed, birthday, gender, note),
    )
    return {"id": new_id}


@app.put("/api/pets/{pet_id}")
def update_pet(pet_id: int, body: PetIn, uid: int = Depends(current_user)):
    owned = query("SELECT id FROM pets WHERE id = %s AND user_id = %s", (pet_id, uid), one=True)
    if not owned:
        raise HTTPException(404, "宠物不存在")
    name, species, avatar, breed, birthday, gender, note = _pet_values(body)
    execute(
        """UPDATE pets SET name=%s, species=%s, avatar=%s, breed=%s, birthday=%s, gender=%s, note=%s
           WHERE id=%s AND user_id=%s""",
        (name, species, avatar, breed, birthday, gender, note, pet_id, uid),
    )
    # 任务里的宠物名是快照，改名后同步更新，保证提醒文案与列表一致
    execute("UPDATE tasks SET pet_name=%s WHERE pet_id=%s AND user_id=%s", (name, pet_id, uid))
    return {"ok": True}


@app.delete("/api/pets/{pet_id}")
def delete_pet(pet_id: int, force: bool = False, uid: int = Depends(current_user)):
    """删除宠物：默认在有关联任务时拒绝，前端确认后带 force=1 级联删除任务

    打卡记录不删除（历史留档），只把 pet_id 置空，保留宠物名快照。
    """
    owned = query("SELECT id, name FROM pets WHERE id = %s AND user_id = %s", (pet_id, uid), one=True)
    if not owned:
        raise HTTPException(404, "宠物不存在")
    cnt = query("SELECT COUNT(*) AS c FROM tasks WHERE pet_id = %s AND user_id = %s", (pet_id, uid), one=True)["c"]
    if cnt and not force:
        raise HTTPException(409, f"该宠物下还有 {cnt} 个护理任务，确认后可一并删除")
    execute("UPDATE records SET pet_id = NULL WHERE pet_id = %s AND user_id = %s", (pet_id, uid))
    execute("DELETE FROM tasks WHERE pet_id = %s AND user_id = %s", (pet_id, uid))
    execute("DELETE FROM pet_weights WHERE pet_id = %s AND user_id = %s", (pet_id, uid))
    execute("DELETE FROM pets WHERE id = %s AND user_id = %s", (pet_id, uid))
    return {"ok": True, "deletedTasks": cnt}


# ---------- 护理模板（一键为新宠物安排标准计划） ----------
# 说明：这里的间隔是常见家庭护理参考值，仅作为初始值，用户可自行修改；
# 不做任何诊断或用药建议（个人主体红线）。
PET_TEMPLATES = {
    "dog":     [("驱虫", 30), ("疫苗", 365), ("体检", 180), ("洗澡", 30)],
    "cat":     [("驱虫", 30), ("疫苗", 365), ("体检", 180)],
    "rabbit":  [("驱虫", 90), ("体检", 180), ("剪指甲", 30)],
    "hamster": [("换垫料", 7), ("体检", 180)],
    "bird":    [("换垫纸", 3), ("体检", 180)],
    "fish":    [("换水", 7), ("滤芯更换", 30)],
    "reptile": [("换垫材", 14), ("体检", 180)],
    "other":   [("驱虫", 90), ("体检", 180)],
    "small":   [("驱虫", 90), ("体检", 180)],
}


@app.post("/api/pets/{pet_id}/apply-template")
def apply_pet_template(pet_id: int, body: Optional[TemplateIn] = None, uid: int = Depends(current_user)):
    """给宠物一键生成标准护理任务（同名任务已存在则跳过，不会重复创建）"""
    pet = query(
        "SELECT id, name, species FROM pets WHERE id = %s AND user_id = %s", (pet_id, uid), one=True
    )
    if not pet:
        raise HTTPException(404, "宠物不存在")
    tpl = PET_TEMPLATES.get((pet["species"] or "other").lower(), PET_TEMPLATES["other"])
    existing = {
        (r["type_name"] or "").strip()
        for r in query(
            "SELECT type_name FROM tasks WHERE pet_id = %s AND user_id = %s", (pet_id, uid)
        )
    }
    today = beijing_today()
    quota = 1 if (body and body.subscribeAccepted) else 0
    created = []
    for name, days in tpl:
        if name in existing:
            continue
        nd = today + timedelta(days=days)
        execute(
            """INSERT INTO tasks
               (user_id, pet_id, type_name, pet_name, interval_days, last_done, next_due,
                remind_enabled, remind_hour, advance_days, note, quota)
               VALUES (%s,%s,%s,%s,%s,%s,%s,1,9,0,%s,%s)""",
            (uid, pet_id, name, pet["name"], days, today.isoformat(), nd.isoformat(), "", quota),
        )
        created.append({"typeName": name, "intervalDays": days, "nextDue": nd.isoformat()})
    return {"created": created, "skipped": len(tpl) - len(created)}


# ---------- 体重记录（纯记录，不做健康判断） ----------
def _own_pet(pet_id: int, uid: int):
    pet = query("SELECT id, name FROM pets WHERE id = %s AND user_id = %s", (pet_id, uid), one=True)
    if not pet:
        raise HTTPException(404, "宠物不存在")
    return pet


@app.get("/api/pets/{pet_id}/weights")
def list_weights(pet_id: int, uid: int = Depends(current_user)):
    _own_pet(pet_id, uid)
    rows = query(
        """SELECT id, weight, record_date, note FROM pet_weights
           WHERE pet_id = %s AND user_id = %s ORDER BY record_date ASC, id ASC LIMIT 200""",
        (pet_id, uid),
    )
    return {
        "list": [
            {
                "id": r["id"],
                "weight": float(r["weight"]),
                "date": as_date(r["record_date"]).isoformat(),
                "note": r["note"],
            }
            for r in rows
        ]
    }


@app.post("/api/pets/{pet_id}/weights")
def add_weight(pet_id: int, body: WeightIn, uid: int = Depends(current_user)):
    """记录体重：同一天重复提交视为修改"""
    _own_pet(pet_id, uid)
    if not (0.05 <= body.weight <= 300):
        raise HTTPException(400, "体重需在 0.05-300 公斤之间")
    d = _parse_done_date(body.date, beijing_today())
    existing = query(
        "SELECT id FROM pet_weights WHERE pet_id = %s AND user_id = %s AND record_date = %s",
        (pet_id, uid, d.isoformat()),
        one=True,
    )
    if existing:
        execute(
            "UPDATE pet_weights SET weight = %s, note = %s WHERE id = %s AND user_id = %s",
            (round(body.weight, 2), (body.note or "").strip()[:60], existing["id"], uid),
        )
        return {"id": existing["id"], "updated": True}
    new_id = execute(
        """INSERT INTO pet_weights (user_id, pet_id, weight, record_date, note)
           VALUES (%s,%s,%s,%s,%s)""",
        (uid, pet_id, round(body.weight, 2), d.isoformat(), (body.note or "").strip()[:60]),
    )
    return {"id": new_id, "updated": False}


@app.delete("/api/weights/{weight_id}")
def delete_weight(weight_id: int, uid: int = Depends(current_user)):
    execute("DELETE FROM pet_weights WHERE id = %s AND user_id = %s", (weight_id, uid))
    return {"ok": True}
