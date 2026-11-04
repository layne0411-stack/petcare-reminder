# -*- coding: utf-8 -*-
"""
数据库访问层：同时支持 SQLite（本地开发，零安装）和 MySQL（服务器部署）
- DB_DRIVER=sqlite（默认）：单文件数据库，自动建表
- DB_DRIVER=mysql：读取 MYSQL_* 环境变量连接，表结构见 schema.sql

SQL 统一用 %s 占位符，SQLite 模式下自动转换为 ?。
"""
import os
import queue
import sqlite3
import time
from datetime import date, datetime

DRIVER = os.environ.get("DB_DRIVER", "sqlite")
SQLITE_PATH = os.environ.get("SQLITE_PATH", os.path.join(os.path.dirname(__file__), "petcare.db"))

MYSQL_CONF = dict(
    host=os.environ.get("MYSQL_HOST", "127.0.0.1"),
    port=int(os.environ.get("MYSQL_PORT", "3306")),
    user=os.environ.get("MYSQL_USER", "root"),
    password=os.environ.get("MYSQL_PASSWORD", ""),
    database=os.environ.get("MYSQL_DB", "petcare"),
    charset="utf8mb4",
    cursorclass=None,  # 运行时设置（避免顶层 import pymysql）
    autocommit=True,
)

# 连接超时（秒）：公网 MySQL 建议 8-10，避免偶发抖动直接报错
MYSQL_CONNECT_TIMEOUT = int(os.environ.get("MYSQL_CONNECT_TIMEOUT", "8"))

# SQLite 建表脚本（与 schema.sql 等价）
SQLITE_DDL = """
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  openid TEXT NOT NULL UNIQUE,
  nickname TEXT NOT NULL DEFAULT '',
  avatar TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  last_login_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  pet_id INTEGER,
  type_name TEXT NOT NULL,
  pet_name TEXT NOT NULL DEFAULT '',
  interval_days INTEGER NOT NULL,
  last_done TEXT,
  next_due TEXT NOT NULL,
  remind_enabled INTEGER NOT NULL DEFAULT 1,
  remind_hour INTEGER NOT NULL DEFAULT 9,
  advance_days INTEGER NOT NULL DEFAULT 0,
  quota INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_due ON tasks (remind_enabled, next_due);
CREATE INDEX IF NOT EXISTS idx_user ON tasks (user_id);
CREATE TABLE IF NOT EXISTS records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  task_id INTEGER NOT NULL,
  pet_id INTEGER,
  pet_name TEXT NOT NULL DEFAULT '',
  type_name TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  done_date TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_user_date ON records (user_id, done_date);
CREATE TABLE IF NOT EXISTS pets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  species TEXT NOT NULL DEFAULT 'other',
  avatar TEXT NOT NULL DEFAULT '',
  breed TEXT NOT NULL DEFAULT '',
  birthday TEXT,
  gender INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_pet_user ON pets (user_id);
CREATE TABLE IF NOT EXISTS notify_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  task_id INTEGER NOT NULL,
  task_title TEXT NOT NULL DEFAULT '',
  sent_at TEXT NOT NULL,
  ok INTEGER NOT NULL DEFAULT 0,
  errcode INTEGER NOT NULL DEFAULT 0,
  errmsg TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS pet_weights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  pet_id INTEGER NOT NULL,
  weight REAL NOT NULL,
  record_date TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
"""


def _mysql_connect():
    import pymysql
    conf = dict(MYSQL_CONF)
    conf["cursorclass"] = pymysql.cursors.DictCursor
    conf["connect_timeout"] = MYSQL_CONNECT_TIMEOUT
    conf["read_timeout"] = MYSQL_CONNECT_TIMEOUT * 3
    conf["write_timeout"] = MYSQL_CONNECT_TIMEOUT * 3
    return pymysql.connect(**conf)


# 简单连接池：公网 MySQL 每次新建连接都要 TCP 握手，抖动时极易超时
_POOL = queue.LifoQueue(maxsize=8)


def _acquire():
    """从池中取可用连接；失效连接丢弃重建"""
    while True:
        try:
            conn = _POOL.get_nowait()
        except queue.Empty:
            return _mysql_connect()
        try:
            conn.ping(reconnect=True)
            return conn
        except Exception:
            try:
                conn.close()
            except Exception:
                pass


def _acquire_with_retry(retries=2):
    """建连重试：只在"拿连接"阶段重试，已执行的写操作绝不重试（防重复插入）"""
    last = None
    for i in range(retries + 1):
        try:
            return _acquire()
        except Exception as e:
            last = e
            if i < retries:
                time.sleep(0.5 * (i + 1))
    raise last


def _release(conn):
    try:
        _POOL.put_nowait(conn)
    except queue.Full:
        try:
            conn.close()
        except Exception:
            pass


def _apply(stmt: str) -> str:
    """MySQL 的 %s 占位符 → SQLite 的 ?"""
    return stmt.replace("%s", "?") if DRIVER == "sqlite" else stmt


def query(sql: str, params=(), one: bool = False):
    """查询，返回 dict 列表（one=True 时返回单个 dict 或 None）"""
    if DRIVER == "mysql":
        conn = _acquire_with_retry()
        try:
            with conn.cursor() as cur:
                cur.execute(sql, params)
                rows = cur.fetchall()
        except Exception:
            # 执行失败：连接状态不可信，直接关闭不回池
            try:
                conn.close()
            except Exception:
                pass
            raise
        _release(conn)
    else:
        conn = sqlite3.connect(SQLITE_PATH)
        conn.row_factory = sqlite3.Row
        try:
            rows = [dict(r) for r in conn.execute(_apply(sql), tuple(params)).fetchall()]
        finally:
            conn.close()
    return (rows[0] if rows else None) if one else rows


def execute(sql: str, params=()) -> int:
    """写操作，返回 lastrowid"""
    if DRIVER == "mysql":
        conn = _acquire_with_retry()
        try:
            with conn.cursor() as cur:
                cur.execute(sql, params)
                last_id = cur.lastrowid
        except Exception:
            try:
                conn.close()
            except Exception:
                pass
            raise
        _release(conn)
        return last_id
    else:
        conn = sqlite3.connect(SQLITE_PATH)
        try:
            cur = conn.execute(_apply(sql), tuple(params))
            conn.commit()
            return cur.lastrowid
        finally:
            conn.close()


def init():
    """初始化：SQLite 自动建表；MySQL 请先执行 schema.sql"""
    if DRIVER == "sqlite":
        conn = sqlite3.connect(SQLITE_PATH)
        try:
            conn.executescript(SQLITE_DDL)
            # 老库补列（CREATE TABLE IF NOT EXISTS 不会给已存在的表加字段）
            for table in ("tasks", "records"):
                cols = {r[1] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}
                if "pet_id" not in cols:
                    conn.execute(f"ALTER TABLE {table} ADD COLUMN pet_id INTEGER")
            tcols = {r[1] for r in conn.execute("PRAGMA table_info(tasks)").fetchall()}
            if "remind_hour" not in tcols:
                conn.execute("ALTER TABLE tasks ADD COLUMN remind_hour INTEGER NOT NULL DEFAULT 9")
            if "advance_days" not in tcols:
                conn.execute("ALTER TABLE tasks ADD COLUMN advance_days INTEGER NOT NULL DEFAULT 0")
            conn.commit()
        finally:
            conn.close()
        print(f"[db] SQLite 就绪：{SQLITE_PATH}")
    else:
        print(f"[db] MySQL 模式：{MYSQL_CONF['host']}:{MYSQL_CONF['port']}/{MYSQL_CONF['database']}（请确认已导入 schema.sql）")


def as_date(v):
    """数据库返回的日期统一转 datetime.date（MySQL 是 date 对象，SQLite 是字符串）"""
    if isinstance(v, date):
        return v
    return datetime.strptime(str(v)[:10], "%Y-%m-%d").date()
