# -*- coding: utf-8 -*-
"""
迁移 v2（幂等，可重复执行）：
1. tasks 增加 remind_hour（提醒整点，默认 9）、advance_days（提前提醒天数，默认 0）
2. 新建 notify_logs（提醒发送日志，用于可靠性排查与防重复）
3. 新建 pet_weights（体重记录）

用法：
  cd backend && .venv/Scripts/python -m migrate_v2
"""
import os

from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))

from database import DRIVER, MYSQL_CONF, query, execute  # noqa: E402


def _columns(table: str):
    if DRIVER == "mysql":
        rows = query(
            """SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
               WHERE TABLE_SCHEMA = %s AND TABLE_NAME = %s""",
            (MYSQL_CONF["database"], table),
        )
        return {r["name"].lower() for r in rows}
    rows = query(f"PRAGMA table_info({table})")
    return {r["name"].lower() for r in rows}


def _tables():
    if DRIVER == "mysql":
        rows = query(
            "SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = %s",
            (MYSQL_CONF["database"],),
        )
        return {r["name"].lower() for r in rows}
    rows = query("SELECT name FROM sqlite_master WHERE type='table'")
    return {r["name"].lower() for r in rows}


DDL_MYSQL = {
    "notify_logs": """
        CREATE TABLE IF NOT EXISTS notify_logs (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL,
          task_id INT NOT NULL,
          task_title VARCHAR(60) NOT NULL DEFAULT '',
          sent_at DATETIME NOT NULL,
          ok TINYINT NOT NULL DEFAULT 0,
          errcode INT NOT NULL DEFAULT 0,
          errmsg VARCHAR(120) NOT NULL DEFAULT ''
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """,
    "pet_weights": """
        CREATE TABLE IF NOT EXISTS pet_weights (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL,
          pet_id INT NOT NULL,
          weight DECIMAL(5,2) NOT NULL,
          record_date DATE NOT NULL,
          note VARCHAR(60) NOT NULL DEFAULT '',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """,
}

DDL_SQLITE = {
    "notify_logs": """
        CREATE TABLE IF NOT EXISTS notify_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          task_id INTEGER NOT NULL,
          task_title TEXT NOT NULL DEFAULT '',
          sent_at TEXT NOT NULL,
          ok INTEGER NOT NULL DEFAULT 0,
          errcode INTEGER NOT NULL DEFAULT 0,
          errmsg TEXT NOT NULL DEFAULT ''
        )
    """,
    "pet_weights": """
        CREATE TABLE IF NOT EXISTS pet_weights (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          pet_id INTEGER NOT NULL,
          weight REAL NOT NULL,
          record_date TEXT NOT NULL,
          note TEXT NOT NULL DEFAULT '',
          created_at TEXT DEFAULT (datetime('now','localtime'))
        )
    """,
}


def main():
    print(f"[migrate v2] driver = {DRIVER}")

    # 1. tasks 补列
    cols = _columns("tasks")
    if "remind_hour" not in cols:
        execute("ALTER TABLE tasks ADD COLUMN remind_hour INT NOT NULL DEFAULT 9")
        print("  + tasks.remind_hour")
    else:
        print("  = tasks.remind_hour 已存在")
    if "advance_days" not in cols:
        execute("ALTER TABLE tasks ADD COLUMN advance_days INT NOT NULL DEFAULT 0")
        print("  + tasks.advance_days")
    else:
        print("  = tasks.advance_days 已存在")

    # 2. 新表
    existing = _tables()
    ddl = DDL_MYSQL if DRIVER == "mysql" else DDL_SQLITE
    for name, sql in ddl.items():
        if name in existing:
            print(f"  = {name} 已存在")
            continue
        execute(sql)
        print(f"  + {name} 已创建")

    # 3. 索引（MySQL 不支持 IF NOT EXISTS 的 ADD INDEX，忽略重复报错）
    for stmt in (
        "CREATE INDEX idx_notify_user ON notify_logs (user_id, sent_at)",
        "CREATE INDEX idx_notify_task ON notify_logs (task_id, ok)",
        "CREATE INDEX idx_weight_pet ON pet_weights (pet_id, record_date)",
    ):
        try:
            execute(stmt)
            print(f"  + index {stmt.split()[2]}")
        except Exception as e:  # 已存在则跳过
            print(f"  = index 跳过（{str(e)[:60]}）")

    # 4. 校验
    print("  tasks 列:", sorted(_columns("tasks")))
    print("  表:", sorted(_tables()))
    print("[migrate v2] 完成")


if __name__ == "__main__":
    main()
