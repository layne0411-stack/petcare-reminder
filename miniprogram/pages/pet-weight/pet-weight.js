// pages/pet-weight/pet-weight.js — 体重记录（纯记录，不给健康建议）
const { request } = require('../../utils/api.js');
const { openModal, modalHandlers, DEFAULT_MODAL } = require('../../utils/ui.js');

Page({
  ...modalHandlers,

  data: {
    modal: Object.assign({}, DEFAULT_MODAL),
    petId: 0,
    petName: '',
    petAvatar: '🐾',
    loading: true,
    weights: [],        // 升序
    latest: null,
    changeText: '',
    changeClass: '',
    bars: [],           // 图表柱：{ h, label, value }
    inputWeight: '',
    inputDate: '',
    today: '',
    saving: false
  },

  onLoad(options) {
    const id = Number(options.id) || 0;
    const today = this.todayStr();
    this.setData({
      petId: id,
      petName: decodeURIComponent(options.name || '崽崽'),
      petAvatar: decodeURIComponent(options.avatar || '🐾'),
      inputDate: today,
      today
    });
    wx.setNavigationBarTitle({ title: `${this.data.petName}的体重` });
    this.loadWeights();
  },

  onPullDownRefresh() {
    this.loadWeights().finally(() => wx.stopPullDownRefresh());
  },

  async loadWeights() {
    if (!this.data.petId) return;
    try {
      const res = await request(`/api/pets/${this.data.petId}/weights`);
      const list = res.list || [];
      const latest = list.length ? list[list.length - 1] : null;
      const prev = list.length > 1 ? list[list.length - 2] : null;

      let changeText = '';
      let changeClass = '';
      if (latest && prev) {
        const diff = latest.weight - prev.weight;
        if (Math.abs(diff) < 0.01) {
          changeText = '和上次一样';
          changeClass = 'same';
        } else {
          changeText = `${diff > 0 ? '+' : ''}${diff.toFixed(2)} kg`;
          changeClass = diff > 0 ? 'up' : 'down';
        }
      }

      this.setData({
        weights: list.slice().reverse(),   // 列表倒序展示
        latest,
        changeText,
        changeClass,
        bars: this.buildBars(list.slice(-8)),
        loading: false
      });
    } catch (err) {
      console.error('加载体重失败:', err);
      this.setData({ loading: false });
      wx.showToast({ title: '加载失败', icon: 'none' });
    }
  },

  /** 最近的体重画成小柱子，高度按区间归一化（留 30% 底，视觉上有起伏） */
  buildBars(list) {
    if (!list.length) return [];
    const values = list.map(w => w.weight);
    const max = Math.max.apply(null, values);
    const min = Math.min.apply(null, values);
    const span = max - min;
    return list.map(w => {
      const ratio = span < 0.01 ? 0.7 : 0.35 + ((w.weight - min) / span) * 0.65;
      return {
        h: Math.round(ratio * 100),
        label: w.date.slice(5).replace('-', '/'),
        value: w.weight
      };
    });
  },

  onWeightInput(e) {
    this.setData({ inputWeight: String(e.detail.value || '').replace(/[^\d.]/g, '') });
  },

  onDateChange(e) {
    this.setData({ inputDate: e.detail.value });
  },

  async onSave() {
    const { inputWeight, inputDate, petId, saving } = this.data;
    if (saving) return;
    const w = Number(inputWeight);
    if (!w || w <= 0) {
      wx.showToast({ title: '填一下体重吧', icon: 'none' });
      return;
    }
    if (w > 300) {
      wx.showToast({ title: '体重看起来不太对', icon: 'none' });
      return;
    }
    this.setData({ saving: true });
    try {
      await request(`/api/pets/${petId}/weights`, {
        method: 'POST',
        data: { weight: w, date: inputDate }
      });
      this.setData({ inputWeight: '' });
      wx.showToast({ title: '已记录', icon: 'success' });
      this.loadWeights();
    } catch (err) {
      const msg = (err && err.detail) || '保存失败';
      wx.showToast({ title: String(msg).slice(0, 20), icon: 'none' });
    } finally {
      this.setData({ saving: false });
    }
  },

  async onDelete(e) {
    const id = Number(e.currentTarget.dataset.id);
    const item = this.data.weights.find(w => w.id === id);
    if (!item) return;
    const r = await openModal(this, {
      emoji: '🗑',
      title: '删掉这条体重记录？',
      desc: `${item.date} · ${item.weight} kg`,
      confirmText: '删除',
      cancelText: '保留',
      danger: true
    });
    if (!r.confirm) return;
    try {
      await request(`/api/weights/${id}`, { method: 'DELETE' });
      this.loadWeights();
    } catch (err) {
      console.error('删除体重失败:', err);
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
