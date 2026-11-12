-- 宠物护理提醒 · MySQL 建表脚本
-- 使用：mysql -u root -p < schema.sql

CREATE DATABASE IF NOT EXISTS petcare DEFAULT CHARACTER SET utf8mb4;
USE petcare;

-- 用户表（静默登录时 upsert）
CREATE TABLE IF NOT EXISTS users (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  openid VARCHAR(64) NOT NULL UNIQUE,
  nickname VARCHAR(50) NOT NULL DEFAULT '' COMMENT '用户昵称',
  avatar VARCHAR(255) NOT NULL DEFAULT '' COMMENT 'emoji 或 /uploads/xxx.png',
  quota INT NOT NULL DEFAULT 0 COMMENT '订阅消息可发送配额（用户级池子）',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_login_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- 已有库升级（users 表已存在时执行）：
-- ALTER TABLE users ADD COLUMN nickname VARCHAR(50) NOT NULL DEFAULT '' AFTER openid;
-- ALTER TABLE users ADD COLUMN avatar VARCHAR(255) NOT NULL DEFAULT '' AFTER nickname;
-- ALTER TABLE users ADD COLUMN quota INT NOT NULL DEFAULT 0 COMMENT '订阅消息可发送配额（用户级池子）' AFTER avatar;
-- 配额迁移：任务级 → 用户级（后端启动时也会自动执行）
-- UPDATE users u SET quota = (SELECT COALESCE(SUM(t.quota),0) FROM tasks t WHERE t.user_id = u.id AND t.remind_enabled = 1);

-- 宠物档案表（多宠物管理）
CREATE TABLE IF NOT EXISTS pets (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  name VARCHAR(30) NOT NULL COMMENT '宠物名，如 豆豆',
  species VARCHAR(10) NOT NULL DEFAULT 'other' COMMENT 'dog/cat/rabbit/hamster/bird/fish/reptile/other',
  avatar VARCHAR(255) NOT NULL DEFAULT '' COMMENT 'emoji 头像或 /uploads/xxx.jpg 照片',
  breed VARCHAR(30) NOT NULL DEFAULT '' COMMENT '品种',
  birthday DATE NULL COMMENT '生日',
  gender TINYINT NOT NULL DEFAULT 0 COMMENT '0未知 1公 2母',
  note VARCHAR(100) NOT NULL DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_pet_user (user_id)
) ENGINE=InnoDB;

-- 任务表
CREATE TABLE IF NOT EXISTS tasks (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  pet_id INT UNSIGNED NULL COMMENT '关联宠物，NULL 表示家居/设备类任务',
  type_name VARCHAR(30) NOT NULL COMMENT '任务名：驱虫/体检/滤芯更换等',
  pet_name VARCHAR(30) NOT NULL DEFAULT '' COMMENT '宠物/设备名快照',
  interval_days INT NOT NULL COMMENT '重复间隔天数',
  last_done DATE NULL COMMENT '上次完成日期',
  next_due DATE NOT NULL COMMENT '下次到期日期',
  remind_enabled TINYINT(1) NOT NULL DEFAULT 1 COMMENT '是否开启提醒',
  remind_hour TINYINT NOT NULL DEFAULT 9 COMMENT '提醒时间（整点 0-23）',
  advance_days TINYINT NOT NULL DEFAULT 0 COMMENT '提前提醒天数，0=到期当天',
  quota INT NOT NULL DEFAULT 0 COMMENT '已废弃：配额已迁移到 users.quota（用户级池子）',
  note VARCHAR(100) NOT NULL DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_due (remind_enabled, next_due),
  INDEX idx_user (user_id),
  INDEX idx_task_pet (pet_id)
) ENGINE=InnoDB;

-- 完成记录表
CREATE TABLE IF NOT EXISTS records (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  task_id INT UNSIGNED NOT NULL,
  pet_id INT UNSIGNED NULL COMMENT '打卡时的宠物，宠物删除后保留 NULL 与名字快照',
  pet_name VARCHAR(30) NOT NULL DEFAULT '',
  type_name VARCHAR(30) NOT NULL,
  note VARCHAR(100) NOT NULL DEFAULT '',
  done_date DATE NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_date (user_id, done_date)
) ENGINE=InnoDB;

-- 已有库升级（多宠物改造，早期库执行一次）：
-- ALTER TABLE tasks ADD COLUMN pet_id INT UNSIGNED NULL AFTER user_id, ADD INDEX idx_task_pet (pet_id);
-- ALTER TABLE records ADD COLUMN pet_id INT UNSIGNED NULL AFTER task_id;

-- 提醒发送日志（可靠性排查 + 防重复发送）
CREATE TABLE IF NOT EXISTS notify_logs (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  task_id INT UNSIGNED NOT NULL,
  task_title VARCHAR(60) NOT NULL DEFAULT '',
  sent_at DATETIME NOT NULL,
  ok TINYINT NOT NULL DEFAULT 0 COMMENT '1=成功',
  errcode INT NOT NULL DEFAULT 0 COMMENT '微信返回码，43101=用户未订阅',
  errmsg VARCHAR(120) NOT NULL DEFAULT '',
  INDEX idx_notify_user (user_id, sent_at),
  INDEX idx_notify_task (task_id, ok)
) ENGINE=InnoDB;

-- 体重记录（纯记录，不做健康判断）
CREATE TABLE IF NOT EXISTS pet_weights (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  pet_id INT UNSIGNED NOT NULL,
  weight DECIMAL(5,2) NOT NULL COMMENT '公斤',
  record_date DATE NOT NULL,
  note VARCHAR(60) NOT NULL DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_weight_pet (pet_id, record_date)
) ENGINE=InnoDB;

-- 已有库升级（v2，2026-11-03）：
-- ALTER TABLE tasks ADD COLUMN remind_hour TINYINT NOT NULL DEFAULT 9 AFTER remind_enabled;
-- ALTER TABLE tasks ADD COLUMN advance_days TINYINT NOT NULL DEFAULT 0 AFTER remind_hour;
