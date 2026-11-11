// pages/pet-edit/pet-edit.js — 新增/编辑宠物档案
const { todayStr } = require('../../utils/util.js');
const { request, getBaseUrl } = require('../../utils/api.js');
const { openModal, modalHandlers, DEFAULT_MODAL } = require('../../utils/ui.js');

const SPECIES = [
  { key: 'dog',     label: '狗狗', emoji: '🐶', breedTip: '如：柯基 / 金毛 / 中华田园犬' },
  { key: 'cat',     label: '猫猫', emoji: '🐱', breedTip: '如：英短 / 布偶 / 中华田园猫' },
  { key: 'rabbit',  label: '兔兔', emoji: '🐰', breedTip: '如：垂耳兔 / 侏儒兔' },
  { key: 'hamster', label: '仓鼠', emoji: '🐹', breedTip: '如：金丝熊 / 布丁 / 三线' },
  { key: 'bird',    label: '鸟鸟', emoji: '🦜', breedTip: '如：玄凤 / 虎皮 / 牡丹鹦鹉' },
  { key: 'fish',    label: '鱼鱼', emoji: '🐠', breedTip: '如：金鱼 / 孔雀鱼 / 斗鱼' },
  { key: 'reptile', label: '爬宠', emoji: '🦎', breedTip: '如：巴西龟 / 草龟 / 豹纹守宫' },
  { key: 'other',   label: '其他', emoji: '🐾', breedTip: '如：龙猫 / 刺猬 / 蜜袋鼯' }
];

// 可选 emoji 头像（猫狗、小宠、鸟类、水族、爬宠都有覆盖）
const AVATARS = ['🐶', '🐱', '🐰', '🐹', '🐭', '🦊', '🐼', '🐷', '🦎', '🐢', '🦜', '🐠'];

const GENDERS = [
  { value: 0, label: '不填' },
  { value: 1, label: '弟弟' },
  { value: 2, label: '妹妹' }
];

const SPECIES_EMOJIS = SPECIES.map(s => s.emoji);

// 一键护理计划会生成哪些任务（仅用于弹窗文案，实际以后端模板为准）
const TEMPLATE_HINT = {
  dog: '驱虫 / 疫苗 / 体检 / 洗澡 四项',
  cat: '驱虫 / 疫苗 / 体检 三项',
  rabbit: '驱虫 / 体检 / 剪指甲 三项',
  hamster: '换垫料 / 体检 两项',
  bird: '换垫纸 / 体检 两项',
  fish: '换水 / 滤芯更换 两项',
  reptile: '换垫材 / 体检 两项',
  other: '驱虫 / 体检 两项'
};

// 历史数据的 species 值映射（早期只有 dog/cat/small/other）
const LEGACY_SPECIES = { small: 'rabbit' };

Page({
  ...modalHandlers,

  data: {
    isEdit: false,
    modal: Object.assign({}, DEFAULT_MODAL),
    species: SPECIES,
    avatars: AVATARS,
    genders: GENDERS,
    speciesKey: 'dog',
    breedTip: SPECIES[0].breedTip,
    name: '',
    avatar: '🐶',
    avatarImg: '',      // 上传后的照片地址（空则显示 emoji）
    avatarEmoji: '🐶',  // 没有照片时展示的 emoji
    breed: '',
    birthday: '',
    today: '',
    gender: 0,
    note: '',
    saving: false
  },

  onLoad(options) {
    this.setData({ today: todayStr() });
    if (options.id) {
      this.setData({ isEdit: true, petId: Number(options.id) });
      wx.setNavigationBarTitle({ title: '编辑宠物' });
      request(`/api/pets/${options.id}`)
        .then(p => {
          const spKey = LEGACY_SPECIES[p.species] || p.species || 'other';
          const sp = SPECIES.find(s => s.key === spKey) || SPECIES[SPECIES.length - 1];
          this.setData({
            name: p.name || '',
            speciesKey: sp.key,
            breedTip: sp.breedTip,
            avatar: p.avatar || '🐾',
            avatarImg: p.avatarImg ? getBaseUrl() + p.avatarImg : '',
            avatarEmoji: p.avatarEmoji || sp.emoji,
            breed: p.breed || '',
            birthday: p.birthday || '',
            gender: p.gender || 0,
            note: p.note || ''
          });
        })
        .catch(err => {
          console.error('读取宠物失败:', err);
          wx.showToast({ title: '宠物不存在', icon: 'none' });
          setTimeout(() => wx.navigateBack(), 800);
        });
    } else {
      wx.setNavigationBarTitle({ title: '添加宠物' });
    }
  },

  onNameInput(e) { this.setData({ name: e.detail.value }); },
  onBreedInput(e) { this.setData({ breed: e.detail.value }); },
  onNoteInput(e) { this.setData({ note: e.detail.value }); },
  onBirthdayChange(e) { this.setData({ birthday: e.detail.value }); },

  onPickSpecies(e) {
    const key = e.currentTarget.dataset.key;
    const sp = SPECIES.find(s => s.key === key);
    // 没上传照片、且头像是跟着种类走的默认 emoji 时，随种类一起换
    const follow = !this.data.avatarImg && SPECIES_EMOJIS.indexOf(this.data.avatar) >= 0;
    this.setData({
      speciesKey: key,
      breedTip: sp.breedTip,
      avatar: follow ? sp.emoji : this.data.avatar,
      avatarEmoji: follow ? sp.emoji : this.data.avatarEmoji
    });
  },

  onPickAvatar(e) {
    // 选 emoji 视为放弃照片
    const emoji = e.currentTarget.dataset.avatar;
    this.setData({ avatar: emoji, avatarEmoji: emoji, avatarImg: '' });
  },

  /** 上传宠物照片当头像（存到自己的后端，仅本人可见） */
  onPickPhoto() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      sizeType: ['compressed'],
      success: res => {
        const f = res.tempFiles && res.tempFiles[0];
        if (f && f.tempFilePath) this.uploadPhoto(f.tempFilePath);
      },
      fail: err => {
        const msg = (err && err.errMsg) || '';
        if (msg.indexOf('cancel') !== -1) return;
        console.error('选择宠物照片失败:', err);
        if (msg.indexOf('privacy') !== -1 || msg.indexOf('declared') !== -1) {
          wx.showToast({ title: '小程序后台需先声明「照片或视频」权限', icon: 'none', duration: 3000 });
        } else {
          wx.showToast({ title: '选择图片失败: ' + msg, icon: 'none', duration: 3000 });
        }
      }
    });
  },

  uploadPhoto(tempPath) {
    wx.showLoading({ title: '上传中', mask: true });
    wx.getFileSystemManager().readFile({
      filePath: tempPath,
      encoding: 'base64',
      success: res => {
        const m = /\.(jpe?g|png|webp|gif)(?:$|\?)/i.exec(tempPath);
        const ext = m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'png';
        const mime = ext === 'jpg' ? 'jpeg' : ext;
        const dataUrl = `data:image/${mime};base64,${res.data}`;
        request('/api/pet-avatar', { method: 'POST', data: { dataUrl } })
          .then(r => {
            wx.hideLoading();
            const path = (r && r.avatar) || '';
            const imgSrc = (r && r.avatarDataUrl) || (path ? getBaseUrl() + path : '');
            this.setData({ avatar: path || this.data.avatar, avatarImg: imgSrc });
            wx.showToast({ title: '照片已选好', icon: 'success' });
          })
          .catch(err => {
            wx.hideLoading();
            console.error('上传宠物照片失败:', err);
            const msg = (err && err.detail) || (err && err.message) || '上传失败，请重试';
            wx.showToast({ title: String(msg).slice(0, 20), icon: 'none' });
          });
      },
      fail: err => {
        wx.hideLoading();
        console.error('读取图片失败:', err);
        wx.showToast({ title: '读取图片失败', icon: 'none' });
      }
    });
  },

  /** 去掉照片，回到 emoji */
  onClearPhoto() {
    const sp = SPECIES.find(s => s.key === this.data.speciesKey) || SPECIES[SPECIES.length - 1];
    this.setData({ avatar: sp.emoji, avatarEmoji: sp.emoji, avatarImg: '' });
  },

  onPickGender(e) {
    this.setData({ gender: Number(e.currentTarget.dataset.value) });
  },

  async onSave() {
    const d = this.data;
    if (d.saving) return;
    const name = (d.name || '').trim();
    if (!name) {
      wx.showToast({ title: '给崽崽起个名字吧', icon: 'none' });
      return;
    }
    this.setData({ saving: true });
    const payload = {
      name,
      species: d.speciesKey,
      avatar: d.avatar,
      breed: (d.breed || '').trim(),
      birthday: d.birthday || null,
      gender: d.gender,
      note: (d.note || '').trim()
    };
    try {
      let newId = 0;
      if (d.isEdit) {
        await request(`/api/pets/${d.petId}`, { method: 'PUT', data: payload });
      } else {
        const res = await request('/api/pets', { method: 'POST', data: payload });
        newId = res && res.id;
      }
      this.setData({ saving: false });

      // 新建宠物后：顺手一键生成标准护理计划（不强制，用户可拒绝）
      if (newId) {
        const sp = SPECIES.find(s => s.key === d.speciesKey) || SPECIES[SPECIES.length - 1];
        const want = await openModal(this, {
          emoji: '✨',
          title: '顺手安排好护理计划？',
          desc: `按${sp.label}常见的护理节奏，帮你一次建好${TEMPLATE_HINT[sp.key] || '基础'}任务，之后可以随时改间隔。`,
          confirmText: '一键安排',
          cancelText: '先不用'
        });
        if (want.confirm) {
          const accepted = await this.requestSubscribe();
          try {
            const r = await request(`/api/pets/${newId}/apply-template`, {
              method: 'POST',
              data: { subscribeAccepted: accepted }
            });
            const n = (r.created || []).length;
            wx.showToast({ title: n ? `已安排 ${n} 条护理计划` : '已经有计划啦', icon: 'none' });
          } catch (e) {
            console.error('套用护理模板失败:', e);
          }
        }
      }

      wx.showToast({ title: '已保存', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 700);
    } catch (err) {
      console.error('保存宠物失败:', err);
      const msg = (err && err.detail) || '保存失败，请重试';
      wx.showToast({ title: String(msg).slice(0, 20), icon: 'none' });
      this.setData({ saving: false });
    }
  },

  /** 请求订阅授权（必须在用户点击链路里调用） */
  requestSubscribe() {
    return new Promise(resolve => {
      wx.requestSubscribeMessage({
        tmplIds: [getApp().TEMPLATE_ID],
        success: res => resolve(res[getApp().TEMPLATE_ID] === 'accept'),
        fail: () => resolve(false)
      });
    });
  },

  async onDelete() {
    const d = this.data;
    const r = await openModal(this, {
      emoji: d.avatarEmoji || '🐾',
      title: `删除「${d.name}」的档案`,
      desc: '档案删除后无法恢复，已经打过的卡会留在护理记录里。',
      confirmText: '删除',
      cancelText: '再想想',
      danger: true
    });
    if (!r.confirm) return;

    try {
      await request(`/api/pets/${d.petId}`, { method: 'DELETE' });
      wx.showToast({ title: '已删除', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 600);
    } catch (err) {
      const detail = (err && err.detail) || '';
      // 后端在有关联任务时返回 409 + 任务数，二次确认后级联删除
      if (String(detail).includes('护理任务')) {
        const r2 = await openModal(this, {
          emoji: '⚠️',
          title: '还要一起删任务吗？',
          desc: `${detail}。这些任务会一起消失，之后不再提醒。`,
          confirmText: '一起删除',
          cancelText: '保留任务',
          danger: true
        });
        if (!r2.confirm) return;
        try {
          await request(`/api/pets/${d.petId}?force=true`, { method: 'DELETE' });
          wx.showToast({ title: '已删除', icon: 'success' });
          setTimeout(() => wx.navigateBack(), 600);
        } catch (e2) {
          console.error('级联删除失败:', e2);
          wx.showToast({ title: '删除失败', icon: 'none' });
        }
      } else {
        console.error('删除宠物失败:', err);
        wx.showToast({ title: '删除失败', icon: 'none' });
      }
    }
  }
});
