// pages/profile/profile.js — 我的（微信登录身份 + 资料 + 统计）
const { request, getBaseUrl } = require('../../utils/api.js');
const { openModal, modalHandlers, DEFAULT_MODAL } = require('../../utils/ui.js');

const EMOJIS = ['🐶', '🐱', '🐰', '🐹', '🦊', '🐼', '🐨', '🐷'];

Page({
  ...modalHandlers,

  data: {
    loading: true,
    modal: Object.assign({}, DEFAULT_MODAL),
    nickname: '',
    avatar: '🐶',
    isImageAvatar: false,
    avatarImg: '',
    emojis: EMOJIS,
    joinedAt: '',
    taskCount: 0,
    recordCount: 0,
    petCount: 0,
    quotaLeft: 0,
    ringStyle: '',      // 配额圆环（conic-gradient）
    weightTrend: null   // 第一只宠物的体重迷你趋势
  },

  onShow() {
    this.loadProfile();
    this.loadWeightTrend();
  },

  onPullDownRefresh() {
    this.loadProfile().finally(() => wx.stopPullDownRefresh());
  },

  async loadProfile() {
    try {
      const p = await request('/api/user/profile');
      this.applyProfile(p);
    } catch (err) {
      console.error('加载用户资料失败:', err);
      wx.showToast({ title: '加载失败，请检查网络', icon: 'none' });
      this.setData({ loading: false });
    }
  },

  applyProfile(p) {
    const avatar = p.avatar || '🐶';
    const isImage = avatar.indexOf('/uploads/') === 0;
    // 优先用服务端返回的内联 base64：不走网络图片加载，避免域名校验/跨域导致空白
    const imgSrc = p.avatarDataUrl || (isImage ? getBaseUrl() + avatar : '');
    this.setData({
      nickname: p.nickname || '铲屎官',
      avatar,
      isImageAvatar: !!imgSrc,
      avatarImg: imgSrc,
      joinedAt: p.joinedAt || '',
      taskCount: p.taskCount || 0,
      recordCount: p.recordCount || 0,
      petCount: p.petCount || 0,
      quotaLeft: p.quotaLeft || 0,
      ringStyle: this.quotaRing(p.quotaLeft || 0),
      loading: false
    });
    // 供首页问候语使用
    wx.setStorageSync('nickname', p.nickname || '');
    wx.setStorageSync('avatarDataUrl', p.avatarDataUrl || '');
  },

  /** 配额圆环：以 5 条为满格，画出剩余比例 */
  quotaRing(quota) {
    const pct = Math.max(0, Math.min(quota, 5)) / 5;
    const deg = Math.round(pct * 360);
    return `conic-gradient(from -90deg, #FFB088 0deg, var(--peach) ${deg}deg, #FFEFE3 ${deg}deg)`;
  },

  /** 体重迷你趋势：取第一只宠物的最近 5 次记录，画小柱状图 */
  async loadWeightTrend() {
    try {
      const petsRes = await request('/api/pets');
      const pets = petsRes.list || [];
      if (!pets.length) {
        this.setData({ weightTrend: null });
        return;
      }
      const first = pets[0];
      this._firstPetId = first.id;
      this._firstPetName = first.name;
      this._firstPetAvatar = first.avatar;
      const res = await request(`/api/pets/${first.id}/weights`);
      const list = (res.list || []).slice(-5);
      if (list.length < 2) {
        this.setData({ weightTrend: null });
        return;
      }
      const vals = list.map(w => w.weight);
      const min = Math.min(...vals);
      const max = Math.max(...vals);
      const span = max - min;
      const bars = list.map(w => ({
        value: w.weight,
        date: (w.date || '').slice(5),
        h: span < 0.01 ? 70 : Math.round(30 + ((w.weight - min) / span) * 70)
      }));
      const latest = list[list.length - 1].weight;
      const diff = Math.round((latest - list[list.length - 2].weight) * 100) / 100;
      this.setData({
        weightTrend: {
          petName: first.name,
          petAvatar: first.avatar,
          latest,
          diff,
          bars
        }
      });
    } catch (err) {
      console.warn('体重趋势加载失败:', err);
      this.setData({ weightTrend: null });
    }
  },

  /** 头像图片加载失败时的兜底：回退成 emoji，避免显示空白 */
  onAvatarError(e) {
    console.error('[avatar] 图片加载失败:', e && e.detail);
    this.setData({ isImageAvatar: false, avatarImg: '' });
  },

  /** 修改昵称 */
  async onEditNickname() {
    const r = await openModal(this, {
      emoji: '✏️',
      title: '给自己起个名字',
      desc: '首页问候语会用到它',
      input: true,
      inputValue: this.data.nickname === '铲屎官' ? '' : this.data.nickname,
      placeholder: '如：豆豆的铲屎官',
      maxlength: 16,
      confirmText: '保存',
      cancelText: '取消'
    });
    if (!r.confirm) return;
    const nick = (r.content || '').trim();
    if (!nick) {
      wx.showToast({ title: '昵称不能为空', icon: 'none' });
      return;
    }
    try {
      const p = await request('/api/user/profile', { method: 'PUT', data: { nickname: nick } });
      this.applyProfile(p);
      wx.showToast({ title: '已更新', icon: 'success' });
    } catch (err) {
      console.error('更新昵称失败:', err);
      wx.showToast({ title: '保存失败', icon: 'none' });
    }
  },

  /** 选择 emoji 头像 */
  async onPickEmoji(e) {
    const emoji = e.currentTarget.dataset.emoji;
    if (emoji === this.data.avatar) return;
    try {
      const p = await request('/api/user/profile', { method: 'PUT', data: { avatar: emoji } });
      this.applyProfile(p);
      wx.showToast({ title: '头像已更换', icon: 'success' });
    } catch (err) {
      console.error('更换头像失败:', err);
      wx.showToast({ title: '保存失败', icon: 'none' });
    }
  },

  /** 统一上传：读取本地图片转 base64 提交服务端（微信头像 / 相册选图共用） */
  uploadAvatar(tempPath) {
    wx.showLoading({ title: '上传中', mask: true });
    wx.getFileSystemManager().readFile({
      filePath: tempPath,
      encoding: 'base64',
      success: res => {
        // 临时路径可能没有扩展名，MIME 仅作占位，服务端按文件头识别真实格式
        const m = /\.(jpe?g|png|webp|gif)(?:$|\?)/i.exec(tempPath);
        const ext = m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'png';
        const mime = ext === 'jpg' ? 'jpeg' : ext;
        const dataUrl = `data:image/${mime};base64,${res.data}`;
        request('/api/user/avatar', { method: 'POST', data: { dataUrl } })
          .then(r => {
            wx.hideLoading();
            // 直接用服务端回传的 base64 立即显示，不等二次请求
            const path = (r && r.avatar) || '';
            const imgSrc = (r && r.avatarDataUrl) || (path ? getBaseUrl() + path : '');
            this.setData({
              avatar: path || this.data.avatar,
              isImageAvatar: !!imgSrc,
              avatarImg: imgSrc
            });
            wx.showToast({ title: '头像已更新', icon: 'success' });
            this.loadProfile();
          })
          .catch(err => {
            wx.hideLoading();
            console.error('上传头像失败:', err);
            const msg = (err && err.detail) || (err && err.message) || '上传失败，请重试';
            wx.showToast({ title: msg, icon: 'none' });
          });
      },
      fail: err => {
        wx.hideLoading();
        console.error('读取头像失败:', err);
        wx.showToast({ title: '读取图片失败', icon: 'none' });
      }
    });
  },

  /** 使用微信头像（官方头像昵称填写能力，个人主体可用） */
  onChooseWechatAvatar(e) {
    const tempPath = e.detail && e.detail.avatarUrl;
    if (!tempPath) {
      // 未同意隐私保护指引时，微信不会返回头像临时路径
      wx.showToast({ title: '需先同意隐私保护指引才能使用微信头像', icon: 'none' });
      return;
    }
    this.uploadAvatar(tempPath);
  },

  /** 点相机角标：拍照或从相册选一张图作为头像 */
  onPickAlbum() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      sizeType: ['compressed'],
      success: res => {
        const f = res.tempFiles && res.tempFiles[0];
        if (f && f.tempFilePath) this.uploadAvatar(f.tempFilePath);
      },
      fail: err => {
        const msg = (err && err.errMsg) || '';
        // 用户取消选图属正常操作，不打扰
        if (msg.indexOf('cancel') !== -1) return;
        console.error('选择图片失败:', err);
        if (msg.indexOf('privacy') !== -1 || msg.indexOf('declared') !== -1) {
          wx.showToast({ title: '小程序后台需先声明「照片或视频」权限', icon: 'none', duration: 3000 });
        } else {
          wx.showToast({ title: '选择图片失败: ' + msg, icon: 'none', duration: 3000 });
        }
      }
    });
  },

  /** 点体重趋势卡：直接进第一只宠物的体重页 */
  goWeightPage() {
    if (this._firstPetId) {
      const name = encodeURIComponent(this._firstPetName || '崽崽');
      const avatar = encodeURIComponent(this._firstPetAvatar || '🐾');
      wx.navigateTo({ url: `/pages/pet-weight/pet-weight?id=${this._firstPetId}&name=${name}&avatar=${avatar}` });
    } else {
      wx.switchTab({ url: '/pages/pets/pets' });
    }
  },

  /** 续订一次订阅（+1 条发送配额） */
  async onRenewQuota() {
    const accepted = await new Promise(resolve => {
      wx.requestSubscribeMessage({
        tmplIds: [getApp().TEMPLATE_ID],
        success: res => resolve(res[getApp().TEMPLATE_ID] === 'accept'),
        fail: () => resolve(false)
      });
    });
    if (!accepted) {
      wx.showToast({ title: '没授权的话提醒可能发不出去', icon: 'none' });
      return;
    }
    try {
      await request('/api/quota', { method: 'POST', data: {} });
      wx.showToast({ title: '已续订 1 条', icon: 'success' });
      this.loadProfile();
    } catch (err) {
      console.error('续订失败:', err);
      wx.showToast({ title: '续订失败', icon: 'none' });
    }
  },

  /** 查看最近的提醒发送记录：能直接看出「为什么没收到」 */
  async onRemindLogs() {
    let desc;
    try {
      const res = await request('/api/notify/logs');
      const list = res.list || [];
      if (!list.length) {
        desc = '还没有发送记录。\n\n系统每小时扫描一次，到提醒时间、且「可发送提醒」大于 0 时才会真正发出。';
      } else {
        desc = list
          .slice(0, 6)
          .map(l =>
            `${l.sentAt}\n${l.ok ? '✅ 已发送' : '❌ 未发送'} · ${l.title}` +
            (l.ok ? '' : `\n${this.errText(l.errcode)}`)
          )
          .join('\n\n');
      }
    } catch (err) {
      console.error('读取发送记录失败:', err);
      desc = '读取失败，请检查网络';
    }
    openModal(this, {
      emoji: '📮',
      title: '提醒发送记录',
      desc,
      confirmText: '知道了',
      showCancel: false
    });
  },

  errText(code) {
    const map = {
      43101: '原因：用户未授权，或这次的一次性额度已用完',
      40003: '原因：openid 无效（换手机/换微信号登录后需重新授权）',
      47003: '原因：订阅消息模板字段不匹配',
      41030: '原因：订阅消息模板已失效'
    };
    return map[code] || `原因：errcode ${code}`;
  },

  onRemindHelp() {
    openModal(this, {
      emoji: '🔔',
      title: '订阅提醒说明',
      desc:
        '微信规定个人小程序只能使用「一次性订阅」：你每点一次「允许」，服务端可以给你发送一条提醒。\n\n' +
        '建议在弹窗中勾选「总是保持以上选择」，之后保存任务时会自动续上配额。',
      confirmText: '我知道了',
      showCancel: false
    });
  },

  onPrivacy() {
    if (wx.openPrivacyContract) {
      wx.openPrivacyContract({
        fail: () => {
          openModal(this, {
            emoji: '🛡️',
            title: '隐私保护指引',
            desc: '暂时没有取到隐私协议内容，请稍后再试。',
            confirmText: '好的',
            showCancel: false
          });
        }
      });
      return;
    }
    openModal(this, {
      emoji: '🛡️',
      title: '隐私保护指引',
      desc:
        '本小程序仅收集：微信头像与昵称（用于展示你的个人资料）、' +
        '你填写的宠物档案与护理记录（用于计算到期时间并发送提醒）。\n\n' +
        '不收集位置、相册、通讯录、设备信息，不向任何第三方共享。',
      confirmText: '好的',
      showCancel: false
    });
  },

  onAbout() {
    openModal(this, {
      emoji: '🐾',
      title: '关于崽崽打卡站',
      desc:
        '一个安安静静的宠物与家居护理提醒工具。\n\n' +
        '数据保存在你自己的账号下，按微信身份隔离，不公开、不分享。',
      confirmText: '好的',
      showCancel: false
    });
  }
});
