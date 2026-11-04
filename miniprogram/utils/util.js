// utils/util.js — 日期工具（全部用 'YYYY-MM-DD' 字符串存储，规避时区问题）

/** Date → 'YYYY-MM-DD'（按本地时区） */
function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 今天的 'YYYY-MM-DD' */
function todayStr() {
  return formatDate(new Date());
}

/** 'YYYY-MM-DD' + days → 新的 'YYYY-MM-DD' */
function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + Number(days));
  return formatDate(dt);
}

/** 目标日期距今天的天数：负数=已过期，0=今天，正数=剩余天数 */
function diffDays(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const target = new Date(y, m - 1, d);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target - today) / 86400000);
}

module.exports = {
  formatDate,
  todayStr,
  addDays,
  diffDays
};
