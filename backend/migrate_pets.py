# -*- coding: utf-8 -*-
"""多宠物改造 · 数据迁移脚本（幂等，可重复执行）

做的三件事：
1. 建 pets 表
2. tasks / records 增加 pet_id 列
3. 把历史任务里的 pet_name（如「豆豆」）归集为宠物档案，并回填 tasks.pet_id、records.pet_id

运行：
    .venv/Scripts/python migrate_pets.py

说明：
- 只做结构升级与数据归集，不删除任何历史数据
- 同名宠物在同一用户下只会建一条档案
"""
import os
import sys

# 必须先加载 .env，否则 database 会按默认的 SQLite 模式启动
try:
    from dotenv import load_dotenv

    load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))
except ImportError:
    pass

from database import DRIVER, query, execute

sys.stdout.reconfigure(encoding="utf-8")

PETS_DDL = """
CREATE TABLE IF NOT EXISTS pets (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  name VARCHAR(30) NOT NULL,
  species VARCHAR(10) NOT NULL DEFAULT 'other',
  avatar VARCHAR(16) NOT NULL DEFAULT '',
  breed VARCHAR(30) NOT NULL DEFAULT '',
  birthday DATE NULL,
  gender TINYINT NOT NULL DEFAULT 0,
  note VARCHAR(100) NOT NULL DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_pet_user (user_id)
) ENGINE=InnoDB
"""


def has_column(table: str, column: str) -> bool:
    if DRIVER == "mysql":
        rows = query(f"SHOW COLUMNS FROM {table} LIKE %s", (column,))
        return bool(rows)
    rows = query(f"PRAGMA table_info({table})")
    return any(r.get("name") == column for r in rows)


def main():
    print(f"[migrate] 数据库类型: {DRIVER}")

    # 1. pets 表
    if DRIVER == "mysql":
        execute(PETS_DDL)
        # MySQL 的 CREATE TABLE 也支持 IF NOT EXISTS，重复执行安全
    else:
        execute(
            """CREATE TABLE IF NOT EXISTS pets (
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
               )"""
        )
    print("[migrate] pets 表就绪")

    # 2. pet_id 列
    for table in ("tasks", "records"):
        if not has_column(table, "pet_id"):
            if DRIVER == "mysql":
                execute(f"ALTER TABLE {table} ADD COLUMN pet_id INT UNSIGNED NULL")
                if table == "tasks":
                    try:
                        execute("ALTER TABLE tasks ADD INDEX idx_task_pet (pet_id)")
                    except Exception as e:
                        print(f"[migrate] 索引已存在或创建失败（可忽略）: {e}")
            else:
                execute(f"ALTER TABLE {table} ADD COLUMN pet_id INTEGER")
            print(f"[migrate] {table}.pet_id 已添加")
        else:
            print(f"[migrate] {table}.pet_id 已存在，跳过")

    # 3. 归集历史 pet_name → pets 档案
    rows = query(
        "SELECT id, user_id, pet_name FROM tasks WHERE pet_id IS NULL AND pet_name <> '' ORDER BY user_id, id"
    )
    created, linked = 0, 0
    for r in rows:
        uid = r["user_id"]
        name = (r["pet_name"] or "").strip()
        if not name:
            continue
        pet = query(
            "SELECT id FROM pets WHERE user_id = %s AND name = %s", (uid, name), one=True
        )
        if pet:
            pid = pet["id"]
        else:
            pid = execute(
                "INSERT INTO pets (user_id, name, species, avatar) VALUES (%s,%s,%s,%s)",
                (uid, name, "other", "🐾"),
            )
            created += 1
        execute("UPDATE tasks SET pet_id = %s WHERE id = %s", (pid, r["id"]))
        linked += 1

    # 4. 记录也回填 pet_id（按用户 + 名字匹配；匹配不到保留原名快照）
    recs = query(
        "SELECT id, user_id, pet_name FROM records WHERE pet_id IS NULL AND pet_name <> ''"
    )
    rec_linked = 0
    for r in recs:
        pet = query(
            "SELECT id FROM pets WHERE user_id = %s AND name = %s",
            (r["user_id"], (r["pet_name"] or "").strip()),
            one=True,
        )
        if pet:
            execute("UPDATE records SET pet_id = %s WHERE id = %s", (pet["id"], r["id"]))
            rec_linked += 1

    print(f"[migrate] 新建宠物档案 {created} 个，关联任务 {linked} 条，回填打卡记录 {rec_linked} 条")

    # 5. 结果概览
    pets = query(
        """SELECT p.id, p.user_id, p.name, p.avatar,
                  (SELECT COUNT(*) FROM tasks t WHERE t.pet_id = p.id) AS task_count
           FROM pets p ORDER BY p.user_id, p.id"""
    )
    for p in pets:
        print(f"  宠物 #{p['id']} user={p['user_id']} {p['name']} {p['avatar']} 任务数={p['task_count']}")
    print("[migrate] 完成")


if __name__ == "__main__":
    main()
