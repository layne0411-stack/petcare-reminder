// utils/api.js — 服务器请求封装 + 静默登录 + 后端地址自动探测 + 环境路由

// 📌 环境区分（与后端 APP_ENV / MYSQL_DB 对应）
//    develop（开发工具/真机调试）→ 本机后端 = uat
//    trial（体验版）            → uat 域名，不通时回落 prod
//    release（正式版）          → prod 域名
//    备案通过后在 mp 后台 request 合法域名里同时配置两个域名即可
const SERVER_PROD = 'https://zaizaidaka.site';        // 生产：petcare 库 + uploads/prod/
const SERVER_UAT = 'https://uat.zaizaidaka.site';     // 测试：petcare_uat 库 + uploads/uat/（子域名随主域名备案，无需单独备案）

// 开发环境候选（顺序即优先级，并发探测取第一个可达的）
const HOSTS_DEV = [
  'http://172.29.161.80:8000',   // ① 本机后端 · 局域网 WLAN（手机同 WiFi 时走这条）
  'http://192.168.255.14:8000',  // ① 备用 · 旧以太网 IP（换了网段时可能命中）
  'http://127.0.0.1:8000',       // ② 本机后端 · 开发者工具
  SERVER_UAT                     // ③ UAT 云服务器（部署后启用）
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
  if (env === 'release') return [SERVER_PROD];
  if (env === 'trial') return [SERVER_UAT, SERVER_PROD];
  return HOSTS_DEV;
}

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

/** 选出可达的后端地址（并发探测，按候选顺序优先） */
function detect() {
  if (BASE_URL) return Promise.resolve(BASE_URL);
  if (!detecting) {
    const hosts = hostList();
    detecting = Promise.all(hosts.map(probe)).then(list => {
      const hit = list.find(h => h);
      BASE_URL = hit || hosts[0];
      detecting = null;
      console.log('[api] 环境:', currentEnv(), '| 后端地址:', BASE_URL, hit ? '✓ 探测成功' : '✗ 全部未通（已回退默认）');
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

module.exports = { detect, login, request, currentEnv, getBaseUrl: () => BASE_URL, getHosts: () => hostList() };
