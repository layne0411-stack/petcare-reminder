# -*- coding: utf-8 -*-
"""
手动触发一次提醒扫描（等价于每小时第 5 分钟的定时任务），用于联调验证。

用法：
  cd backend
  .venv/Scripts/python trigger_notify.py
"""
from app import notify_due_tasks, beijing_today, query

if __name__ == "__main__":
    today = beijing_today()
    print(f"=== 当前北京时间：{today} ===")

    rows = query(
        """SELECT t.id, t.type_name, t.pet_name, t.next_due, t.quota, t.remind_enabled,
                  t.remind_hour, t.advance_days, u.openid
           FROM tasks t JOIN users u ON t.user_id = u.id
           ORDER BY t.id"""
    )
    print(f"共 {len(rows)} 条任务：")
    for r in rows:
        state = []
        if not r["remind_enabled"]:
            state.append("提醒已关闭")
        if r["quota"] <= 0:
            state.append("配额为0→不会发送")
        if str(r["next_due"]) > str(today):
            state.append(f"未到期({r['next_due']})")
        print(
            f"  #{r['id']} {r['pet_name']}{r['type_name']}"
            f" | 到期 {r['next_due']} | 提醒 {r['remind_hour']}点"
            f" | 提前 {r['advance_days']} 天 | 配额 {r['quota']}"
            f" | {'; '.join(state) if state else '✓ 可发送'}"
        )

    print("\n--- 开始发送（忽略提醒整点限制）---")
    print(notify_due_tasks(force=True))
