// app.js — 微信静默登录（后端自建方案）
const { login } = require('./utils/api');

App({
  onLaunch() {
    // 启动即静默登录：wx.login 的 code 换 openid，服务端签发 token
    // 用户无感知，数据按微信身份隔离；失败时各页面请求会自动重试登录
    login()
      .then(res => {
        if (res && res.nickname) {
          wx.setStorageSync('nickname', res.nickname);
        }
        if (res && res.avatar) {
          wx.setStorageSync('avatar', res.avatar);
        }
        if (res && res.avatarDataUrl) {
          // 内联 base64，供任意页面直接当图片 src 使用（不依赖图片域名白名单）
          wx.setStorageSync('avatarDataUrl', res.avatarDataUrl);
        }
      })
      .catch(err => {
        console.error('登录失败:', err);
        wx.showToast({ title: '网络异常，请稍后重试', icon: 'none' });
      });
  },

  globalData: {},

  // 订阅消息模板 ID（前端 wx.requestSubscribeMessage 用；后端发送用 .env 里的同名配置）
  // 「打卡提醒」模板（2026-11-12 切换，字段 thing1=计划名称 / time6=提醒日期 / thing3=备注）
  TEMPLATE_ID: '_uToPaLWxfxat1GGIlvmqtwFGMcpgdSneWNrF8bjyw4'
});
