// pages/pets/pets.js — 宠物档案列表（多宠物管理）
const { request, getBaseUrl } = require('../../utils/api.js');

Page({
  data: {
    loading: true,
    pets: [],
    baseUrl: ''   // 宠物照片是相对路径，渲染时需要拼上服务端地址
  },

  onShow() {
    this.setData({ baseUrl: getBaseUrl() });
    this.loadPets();
  },

  onPullDownRefresh() {
    this.loadPets().finally(() => wx.stopPullDownRefresh());
  },

  async loadPets() {
    try {
      const res = await request('/api/pets');
      const pets = (res.list || []).map(p => {
        let dueText = '还没有护理计划';
        let dueClass = 'due-none';
        if (p.nextDue) {
          if (p.daysLeft < 0) {
            dueText = `⏰ 有任务逾期 ${-p.daysLeft} 天`;
            dueClass = 'due-overdue';
          } else if (p.daysLeft === 0) {
            dueText = '🎉 今天有任务到期';
            dueClass = 'due-today';
          } else {
            dueText = `🗓 最近 ${p.nextDue} 到期（剩 ${p.daysLeft} 天）`;
            dueClass = 'due-ok';
          }
        }
        return Object.assign({}, p, { dueText, dueClass });
      });
      this.setData({ pets, loading: false });
    } catch (err) {
      console.error('加载宠物失败:', err);
      this.setData({ loading: false });
      wx.showToast({ title: '加载失败，请检查网络', icon: 'none' });
    }
  },

  goAdd() {
    wx.navigateTo({ url: '/pages/pet-edit/pet-edit' });
  },

  goEdit(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/pet-edit/pet-edit?id=${id}` });
  },

  goWeight(e) {
    const { id, name, avatar } = e.currentTarget.dataset;
    wx.navigateTo({
      url: `/pages/pet-weight/pet-weight?id=${id}&name=${encodeURIComponent(name || '')}&avatar=${encodeURIComponent(avatar || '')}`
    });
  }
});
