// pages/task-edit/task-edit.js — 新增/编辑任务（自建后端版）
const { todayStr } = require('../../utils/util.js');
const { request } = require('../../utils/api.js');

const PRESETS = [
  { key: 'deworm',   name: '驱虫',       icon: '💊', intervals: [30, 60, 90] },
  { key: 'vaccine',  name: '疫苗',       icon: '💉', intervals: [365] },
  { key: 'checkup',  name: '体检',       icon: '🩺', intervals: [180, 365] },
  { key: 'filter',   name: '滤芯更换',   icon: '🚰', intervals: [60, 90, 180] },
  { key: 'desiccant',name: '干燥剂更换', icon: '🧂', intervals: [30, 60, 90] },
  { key: 'custom',   name: '自定义',     icon: '✨', intervals: [] }
];

Page({
  data: {
    isEdit: false,
    presets: PRESETS,
    activeKey: 'deworm',
    typeName: '驱虫',
    pets: [],        // 宠物档案，用于选择归属
    petId: 0,        // 0 = 家居/设备（不关联宠物）
    petName: '',     // 未关联宠物时的设备名
    intervalDays: 30,
    intervalText: '30',   // 输入框显示值：和数字解耦，允许清空/中间态
    quickIntervals: [30, 60, 90],
    lastDone: '',
    today: '',
    remindEnabled: true,
    remindHour: 9,
    advanceDays: 0,
    remindHours: [
      { value: 8, label: '8:00', emoji: '🌅' },
      { value: 12, label: '12:00', emoji: '☀️' },
      { value: 20, label: '20:00', emoji: '🌙' }
    ],
    hourOptions: Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}:00`),
    isCustomHour: false,
    customHourLabel: '自定义',
    advanceOptions: [
      { value: 0, label: '当天' },
      { value: 1, label: '提前 1 天' },
      { value: 3, label: '提前 3 天' },
      { value: 7, label: '提前 7 天' }
    ],
    note: ''
  },

  onLoad(options) {
    this.setData({ today: todayStr() });
    this.loadPets(options.petId ? Number(options.petId) : 0);
    if (options.id) {
      // 编辑模式：从服务端读取现有任务
      this.setData({ isEdit: true, taskId: Number(options.id) });
      request(`/api/tasks/${options.id}`)
        .then(t => {
          const preset = PRESETS.find(p => p.name === t.typeName);
          this._lastInterval = t.intervalDays;
          this.setData({
            typeName: t.typeName,
            // 回显任务类型：能匹配到预设就高亮对应 chip，否则走「自定义」
            activeKey: preset ? preset.key : 'custom',
            petId: t.petId || 0,
            petName: t.petId ? '' : (t.petName || ''),
            intervalDays: t.intervalDays,
            intervalText: String(t.intervalDays),
            quickIntervals: preset && preset.intervals.length ? preset.intervals : [30, 60, 90],
            lastDone: t.lastDone || '',
            remindEnabled: !!t.remindEnabled,
            remindHour: typeof t.remindHour === 'number' ? t.remindHour : 9,
            advanceDays: typeof t.advanceDays === 'number' ? t.advanceDays : 0,
            note: t.note || ''
          });
          // 让自定义提醒时间在编辑时正确回显（8/12/20 之外的小时显示为具体时间）
          this._syncHourView(typeof t.remindHour === 'number' ? t.remindHour : 9);
          wx.setNavigationBarTitle({ title: '编辑任务' });
        })
        .catch(err => {
          console.error('读取任务失败:', err);
          wx.showToast({ title: '任务不存在', icon: 'none' });
          wx.navigateBack();
        });
    } else {
      this.setData({ lastDone: todayStr() });
    }
  },

  /** 拉宠物列表；optionsPetId 用于从宠物页「加任务」直达 */
  async loadPets(optionsPetId) {
    try {
      const res = await request('/api/pets');
      const pets = (res.list || []).map(p => ({ id: p.id, name: p.name, avatar: p.avatarImg ? p.avatarEmoji : p.avatar }));
      const patch = { pets };
      if (optionsPetId && pets.some(p => p.id === optionsPetId)) patch.petId = optionsPetId;
      this.setData(patch);
    } catch (err) {
      console.error('加载宠物失败:', err);
    }
  },

  onPickPet(e) {
    const id = Number(e.currentTarget.dataset.id) || 0;
    this.setData({ petId: id, petName: id ? '' : this.data.petName });
  },

  goAddPet() {
    wx.navigateTo({ url: '/pages/pet-edit/pet-edit' });
  },

  onShow() {
    // 从宠物页返回时可能新建了宠物：首次 onShow 由 onLoad 负责，之后每次回来刷新
    if (this._shown) this.loadPets(this.data.petId);
    this._shown = true;
    // 预取订阅配额：保存时配额充足就不再弹授权弹窗，避免每次保存都打扰
    this.refreshQuota();
  },

  /** 预取剩余订阅配额（GET /api/quota），保存时据此决定是否弹授权 */
  async refreshQuota() {
    try {
      const q = await request('/api/quota');
      this._quotaLeft = q.quotaLeft || 0;
    } catch (err) {
      console.warn('配额预取失败，保存时将按需弹授权:', err);
      this._quotaLeft = 0; // 查不到就按不足处理，宁可多弹一次
    }
  },

  onPickPreset(e) {
    const key = e.currentTarget.dataset.key;
    const preset = PRESETS.find(p => p.key === key);
    // 只有该类型带预设间隔时才覆盖输入值；自定义类型保留用户已填的天数
    const days = preset.intervals.length ? preset.intervals[0] : this.data.intervalDays;
    if (preset.intervals.length) this._lastInterval = days;
    this.setData({
      activeKey: key,
      typeName: preset.name,
      quickIntervals: preset.intervals,
      intervalDays: days,
      intervalText: days ? String(days) : ''
    });
  },

  onPetNameInput(e) { this.setData({ petName: e.detail.value }); },
  onTypeNameInput(e) { this.setData({ typeName: e.detail.value }); },

  onQuickInterval(e) {
    const days = Number(e.currentTarget.dataset.days);
    this._lastInterval = days;
    this.setData({ intervalDays: days, intervalText: String(days) });
  },

  /** 只保留数字：允许清空、允许中途为空，避免「删不掉原来的 1」 */
  onIntervalInput(e) {
    const raw = String(e.detail.value || '').replace(/[^\d]/g, '').slice(0, 4);
    const n = raw ? Number(raw) : 0;
    if (n > 0) this._lastInterval = n;   // 记住最后一个有效值，供失焦兜底
    this.setData({ intervalText: raw, intervalDays: n });
  },

  /** 失焦时把空值/0 归位成上一个有效值，避免留下一个空框 */
  onIntervalBlur() {
    const raw = String(this.data.intervalText || '').trim();
    const n = Number(raw);
    if (!raw || !n) {
      const back = this._lastInterval || 30;
      this.setData({ intervalText: String(back), intervalDays: back });
      return;
    }
    const v = Math.min(3650, Math.max(1, Math.floor(n)));
    this._lastInterval = v;
    this.setData({ intervalText: String(v), intervalDays: v });
  },

  onLastDoneChange(e) { this.setData({ lastDone: e.detail.value }); },

  /** 同步提醒时间展示：命中 8/12/20 走快捷 chip，否则走自定义 chip 显示具体整点 */
  _syncHourView(hour) {
    const presets = this.data.remindHours.map(h => h.value);
    const hit = presets.indexOf(hour) >= 0;
    const hh = String(hour).padStart(2, '0');
    this.setData({
      remindHour: hour,
      isCustomHour: !hit,
      customHourLabel: hit ? '自定义' : `${hh}:00`
    });
  },
  onPickHour(e) { this._syncHourView(Number(e.currentTarget.dataset.value)); },
  onPickCustomHour(e) { this._syncHourView(Number(e.detail.value)); },
  onPickAdvance(e) { this.setData({ advanceDays: Number(e.currentTarget.dataset.value) }); },
  onNoteInput(e) { this.setData({ note: e.detail.value }); },
  onRemindChange(e) { this.setData({ remindEnabled: e.detail.value }); },

  /** 保存：新增或更新（下次到期日由服务端统一计算） */
  async onSave() {
    const d = this.data;
    if (!d.typeName.trim()) {
      wx.showToast({ title: '请填写任务名称', icon: 'none' });
      return;
    }
    if (!d.intervalDays || d.intervalDays < 1) {
      wx.showToast({ title: '请填写间隔天数', icon: 'none' });
      return;
    }
    if (d.intervalDays > 3650) {
      wx.showToast({ title: '间隔天数最多 3650 天', icon: 'none' });
      return;
    }

    // 开启提醒：借保存这次点击请求订阅授权（微信要求必须在点击上下文同步调用），
    // 把「是否同意」随任务一起提交，由服务端在建任务的同时写入配额，避免配额丢失。
    // 配额充足（剩余 >= 2）时跳过弹窗不打扰用户；不足时才请求授权
    const quotaEnough = d.remindEnabled && (this._quotaLeft || 0) >= 2;
    let subscribeAccepted = false;
    if (d.remindEnabled && !quotaEnough) {
      subscribeAccepted = await this.requestSubscribe();
    }

    const payload = {
      typeName: d.typeName.trim(),
      petId: d.petId || null,
      petName: d.petId ? '' : d.petName.trim(),
      intervalDays: d.intervalDays,
      lastDone: d.lastDone || d.today,
      remindEnabled: d.remindEnabled,
      remindHour: d.remindHour,
      advanceDays: d.advanceDays,
      note: d.note.trim(),
      subscribeAccepted
    };

    try {
      if (d.isEdit) {
        await request(`/api/tasks/${d.taskId}`, { method: 'PUT', data: payload });
      } else {
        await request('/api/tasks', { method: 'POST', data: payload });
      }
      // 只有「配额不足且用户拒绝了授权」才提示未授权；配额充足跳过弹窗属于正常情况
      const declined = d.remindEnabled && !quotaEnough && !subscribeAccepted;
      const tip = declined ? '已保存（未授权提醒）' : '已保存';
      wx.showToast({ title: tip, icon: declined ? 'none' : 'success' });
      setTimeout(() => wx.navigateBack(), 600);
    } catch (err) {
      console.error('保存失败:', err);
      wx.showToast({ title: '保存失败', icon: 'none' });
    }
  },

  /** 请求订阅授权，返回用户是否同意（在保存点击的同一上下文里同步发起） */
  requestSubscribe() {
    return new Promise(resolve => {
      const tid = getApp().TEMPLATE_ID;
      wx.requestSubscribeMessage({
        tmplIds: [tid],
        success: res => {
          const accepted = res[tid] === 'accept';
          if (!accepted) console.warn('用户未同意订阅:', res[tid]);
          resolve(accepted);
        },
        fail: err => {
          console.warn('订阅授权调用失败:', err);
          resolve(false);
        }
      });
    });
  }
});
