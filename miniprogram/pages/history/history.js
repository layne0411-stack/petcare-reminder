// pages/history/history.js — 完成记录（自建后端版）
const { request } = require('../../utils/api.js');
const { openModal, modalHandlers, DEFAULT_MODAL } = require('../../utils/ui.js');

/** 与首页一致的类型图标映射 */
const TYPE_ICONS = [
  { kw: '驱虫', icon: '💊', theme: 'peach' },
  { kw: '疫苗', icon: '💉', theme: 'mint' },
  { kw: '体检', icon: '🩺', theme: 'butter' },
  { kw: '滤芯', icon: '🚰', theme: 'mint' },
  { kw: '干燥剂', icon: '🧂', theme: 'lavender' },
  { kw: '洗澡', icon: '🛁', theme: 'butter' },
  { kw: '美容', icon: '✂️', theme: 'lavender' },
  { kw: '粮', icon: '🥣', theme: 'peach' }
];

function styleFor(typeName) {
  const hit = TYPE_ICONS.find(t => (typeName || '').includes(t.kw));
  return hit ? { icon: hit.icon, theme: hit.theme } : { icon: '🐾', theme: 'peach' };
}

Page({
  ...modalHandlers,

  data: {
    loading: true,
    modal: Object.assign({}, DEFAULT_MODAL),
    records: [],
    empty: false,
    pets: [],         // 宠物筛选条
    activePetId: 0,   // 0 = 全部
    typeChips: [],    // 类型筛选（由记录里出现过的类型动态生成）
    activeType: '',   // '' = 全部类型
    total: 0
  },

  onShow() {
    this.loadAll();
  },

  onPullDownRefresh() {
    this.loadAll().finally(() => wx.stopPullDownRefresh());
  },

  async loadAll() {
    this.setData({ loading: true });
    try {
      const [petsRes, recordsRes] = await Promise.all([
        request('/api/pets'),
        request('/api/records')
      ]);
      this.rawRecords = (recordsRes.list || []).map(r => {
        const s = styleFor(r.typeName);
        r.icon = s.icon;
        r.theme = s.theme;
        r.titleText =
          (r.petAvatar ? r.petAvatar + ' ' : '') +
          (r.petName ? r.petName + '的' : '') +
          r.typeName;
        return r;
      });

      const pets = (petsRes.list || []).map(p => ({ id: p.id, name: p.name, avatar: p.avatar }));

      // 类型筛选：只展示实际出现过的类型，最多 8 个
      const types = [];
      this.rawRecords.forEach(r => {
        if (r.typeName && !types.includes(r.typeName)) types.push(r.typeName);
      });

      let activePetId = this.data.activePetId;
      if (activePetId && !pets.some(p => p.id === activePetId)) activePetId = 0;
      let activeType = this.data.activeType;
      if (activeType && !types.includes(activeType)) activeType = '';

      this.setData({
        pets,
        activePetId,
        typeChips: types.slice(0, 8),
        activeType,
        total: this.rawRecords.length
      });
      this.applyFilter();
    } catch (err) {
      console.error('加载记录失败:', err);
      wx.showToast({ title: '加载失败', icon: 'none' });
      this.setData({ loading: false });
    }
  },

  applyFilter() {
    const { activePetId, activeType } = this.data;
    let list = this.rawRecords || [];
    if (activePetId) list = list.filter(r => r.petId === activePetId);
    if (activeType) list = list.filter(r => r.typeName === activeType);
    this.setData({ records: list, empty: list.length === 0, loading: false });
  },

  onFilterPet(e) {
    const id = Number(e.currentTarget.dataset.id) || 0;
    if (id === this.data.activePetId) return;
    this.setData({ activePetId: id }, () => this.applyFilter());
  },

  onFilterType(e) {
    const t = e.currentTarget.dataset.type || '';
    if (t === this.data.activeType) return;
    this.setData({ activeType: t }, () => this.applyFilter());
  },

  /** 修改这条记录的日期 */
  async onEditDate(e) {
    const id = Number(e.currentTarget.dataset.id);
    const rec = (this.rawRecords || []).find(r => r.id === id);
    if (!rec) return;
    const r = await openModal(this, {
      emoji: '📅',
      title: '改一下完成日期',
      desc: `${rec.petName ? rec.petName + ' 的' : ''}${rec.typeName}，改完会同时重算下次到期日`,
      confirmText: '保存',
      cancelText: '取消',
      picker: true,
      pickerLabel: '完成日期',
      pickerValue: rec.doneDate,
      pickerEnd: this.todayStr()
    });
    if (!r.confirm || r.pickerValue === rec.doneDate) return;
    try {
      await request(`/api/records/${id}`, { method: 'PUT', data: { doneDate: r.pickerValue } });
      wx.showToast({ title: '已更新', icon: 'success' });
      this.loadAll();
    } catch (err) {
      const msg = (err && err.detail) || '修改失败';
      wx.showToast({ title: String(msg).slice(0, 20), icon: 'none' });
    }
  },

  /** 删除这条记录（等于撤销这次打卡） */
  async onDeleteRecord(e) {
    const id = Number(e.currentTarget.dataset.id);
    const rec = (this.rawRecords || []).find(r => r.id === id);
    if (!rec) return;
    const r = await openModal(this, {
      emoji: '🗑',
      title: '撤销这次打卡？',
      desc: `删除后「${rec.typeName}」的下次到期日会回退到上一条记录。`,
      confirmText: '删除',
      cancelText: '保留',
      danger: true
    });
    if (!r.confirm) return;
    try {
      await request(`/api/records/${id}`, { method: 'DELETE' });
      wx.showToast({ title: '已撤销', icon: 'success' });
      this.loadAll();
    } catch (err) {
      console.error('删除记录失败:', err);
      wx.showToast({ title: '删除失败', icon: 'none' });
    }
  },

  todayStr() {
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
  }
});
