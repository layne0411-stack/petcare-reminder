// utils/api.js — 服务器请求封装 + 静默登录 + 后端地址自动探测

// 📌 当前阶段：本机后端（开发调试，手机需与电脑同一局域网）
//    顺序即优先级，启动时并发探测，取第一个可达的
// 📌 备案通过后：把 SERVER 常量换成 'https://zaizaidaka.site'，
//    并在 mp.weixin.qq.com → 开发管理 → 开发设置 → 服务器域名 → request 合法域名 中配置该域名
const SERVER = 'http://152.136.58.30:8001';  // 云服务器（备案后改为 https 域名）

const HOSTS = [
  'http://192.168.255.14:8000',  // ① 本机后端 · 局域网（手机同 WiFi 时走这条）
  'http://127.0.0.1:8000',       // ② 本机后端 · 开发者工具
  SERVER                          // ③ 云服务器（备案通过后启用）
];

let BASE_URL = '';
let detecting = null;

/** 探测单个地址是否可达 */
function probe(host) {
  return new Promise(resolve => {
    wx.request({
      url: `${host}/api/ping`,
      method: 'GET',
      timeout: 2000,
      success: res => resolve(res.statusCode === 200 && res.data && res.data.ok ? host : ''),
      fail: () => resolve('')
    });
  });
}

/** 选出可达的后端地址（并发探测，按 HOSTS 顺序优先） */
function detect() {
  if (BASE_URL) return Promise.resolve(BASE_URL);
  if (!detecting) {
    detecting = Promise.all(HOSTS.map(probe)).then(list => {
      const hit = list.find(h => h);
      BASE_URL = hit || HOSTS[0];
      detecting = null;
      console.log('[api] 后端地址:', BASE_URL, hit ? '✓ 探测成功' : '✗ 全部未通（已回退默认）');
      return BASE_URL;
    });
  }
  return detecting;
}

/** 静默登录：wx.login 的 code 换服务端自定义 token */
function login() {
  return detect().then(base => new Promise((resolve, reject) => {
    wx.login({
      success: ({ code }) => {
        wx.request({
          url: `${base}/api/login`,
          method: 'POST',
          data: { code },
          success: res => {
            if (res.statusCode !== 200) {
              reject(res.data);
              return;
            }
            wx.setStorageSync('token', res.data.token);
            wx.setStorageSync('userId', res.data.userId);
            resolve(res.data);
          },
          fail: reject
        });
      },
      fail: reject
    });
  }));
}

/** 统一请求：自动带 token，401 时自动重登一次再重试 */
function request(path, { method = 'GET', data, _retried = false } = {}) {
  return detect().then(base => new Promise((resolve, reject) => {
    const token = wx.getStorageSync('token');
    wx.request({
      url: `${base}${path}`,
      method,
      data,
      header: token ? { Authorization: `Bearer ${token}` } : {},
      success: res => {
        if (res.statusCode === 401 && !_retried) {
          login()
            .then(() => request(path, { method, data, _retried: true }))
            .then(resolve)
            .catch(reject);
          return;
        }
        if (res.statusCode >= 400) {
          reject(res.data || { message: `请求失败 (${res.statusCode})` });
          return;
        }
        resolve(res.data);
      },
      fail: err => reject(err)
    });
  }));
}

module.exports = { detect, login, request, getBaseUrl: () => BASE_URL, getHosts: () => HOSTS };
