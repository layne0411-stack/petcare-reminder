// utils/api.js — 服务器请求封装 + 静默登录 + 后端地址自动探测 + 环境路由

// 📌 环境路由（2026-11-20：域名备案通过，uat 环境已裁撤，只保留「本地开发 + 生产」两套）
//    develop（开发工具/真机调试）→ 本机 8000
//    trial（体验版）            → 生产域名
//    release（正式版）          → 生产域名
//    ⚠️ 微信后台「服务器域名」需配置 request 与 uploadFile 两项，值均为 https://zaizaidaka.site
const SERVER_PROD = 'https://zaizaidaka.site';   // 生产：petcare 库 + uploads/prod/

// 开发环境候选（并发探测，谁先通就用谁；用于手机真机与开发者工具连本机后端）
// ⚠️ 只放真能访问到的地址：虚拟网卡、已断开的适配器、未解析的域名一律不要放，否则会拖慢探测
const HOSTS_DEV = [
  'http://192.168.31.183:8000',  // ① 本机后端 · 局域网 WLAN（手机同 WiFi 时走这条）
  'http://127.0.0.1:8000'        // ② 本机后端 · 开发者工具
];

let BASE_URL = '';
let detecting = null;
let CURRENT_ENV = '';

/** 读取小程序运行版本：develop / trial / release */
function currentEnv() {
  if (CURRENT_ENV) return CURRENT_ENV;
  try {
    const acc = wx.getAccountInfoSync();
    CURRENT_ENV = (acc && acc.miniProgram && acc.miniProgram.envVersion) || 'develop';
  } catch (e) {
    CURRENT_ENV = 'develop';
  }
  return CURRENT_ENV;
}

/** 按环境返回候选后端地址列表 */
function hostList() {
  const env = currentEnv();
  // 体验版与正式版统一走生产域名（uat 子域已裁撤：单人开发，多一套环境维护成本大于收益）
  if (env === 'trial' || env === 'release') return [SERVER_PROD];
  return HOSTS_DEV;
}

/** 探测单个地址是否可达（带硬超时，避免不可达地址把冷启动拖死） */
function probe(host, ms = 2500) {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    const timer = setTimeout(() => finish(''), ms);
    wx.request({
      url: `${host}/api/ping`,
      method: 'GET',
      timeout: ms,
      success: res => { clearTimeout(timer); finish(res.statusCode === 200 && res.data && res.data.ok ? host : ''); },
      fail: () => { clearTimeout(timer); finish(''); }
    });
  });
}

/** 选出可达的后端地址：并发竞速，谁先通用谁；全失败回退候选首个。绝不等待最慢的那个 */
function detect() {
  if (BASE_URL) return Promise.resolve(BASE_URL);
  if (detecting) return detecting;
  const hosts = hostList();
  // 生产环境只有一个可信域名：不做探测直接使用，省掉首屏 2.5s 的探测开销
  if (hosts.length === 1) {
    BASE_URL = hosts[0];
    console.log('[api] 环境:', currentEnv(), '| 后端地址:', BASE_URL, '（直连，免探测）');
    return Promise.resolve(BASE_URL);
  }
  detecting = new Promise(resolve => {
    let settled = false;
    let pending = hosts.length;
    const settle = (host, note) => {
      if (settled) return;
      settled = true;
      BASE_URL = host;
      console.log('[api] 环境:', currentEnv(), '| 后端地址:', BASE_URL, note);
      resolve(BASE_URL);
    };
    // 兜底：3.5s 内谁都没回话，就用第一个候选，不再干等
    setTimeout(() => settle(hosts[0], '✗ 探测超时，已回退默认'), 3500);
    hosts.forEach(h => {
      probe(h).then(hit => {
        if (hit) { settle(hit, '✓ 探测成功'); return; }
        if (--pending === 0) settle(hosts[0], '✗ 全部未通，已回退默认');
      });
    });
  }).then(v => { detecting = null; return v; });
  return detecting;
}

/** 后端地址失效时清空缓存，下次请求重新探测（换网络、后端重启后可自愈） */
function resetBase() {
  BASE_URL = '';
  detecting = null;
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
          timeout: 15000,
          success: res => {
            if (res.statusCode !== 200) {
              reject(res.data);
              return;
            }
            wx.setStorageSync('token', res.data.token);
            wx.setStorageSync('userId', res.data.userId);
            resolve(res.data);
          },
          fail: err => { resetBase(); reject(err); }
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
      timeout: 15000,
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
      fail: err => { resetBase(); reject(err); }
    });
  }));
}

module.exports = { detect, login, request, currentEnv, resetBase, getBaseUrl: () => BASE_URL, getHosts: () => hostList() };
